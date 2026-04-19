#!/usr/bin/env node

import 'dotenv/config'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import { basename } from 'path'
import type { WebSocket } from 'ws'
import { nanoid } from 'nanoid'

import { closeDb, getDb } from './db/database.js'
import { type ApprovalResult, getHITLGate } from './core/agent/hitl-gate.js'
import { getRAGStore } from './core/memory/rag.js'
import { getEventBus } from './core/telemetry/event-bus.js'

import { registerAgentDefinitionRoutes } from './routes/agents.js'
import { registerChatRoutes } from './routes/chat.js'
import { registerConversationRoutes } from './routes/conversations.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerMcpRoutes, loadSavedMcpServers } from './routes/mcp/index.js'
import { registerProviderRoutes, loadSavedProviders } from './routes/providers.js'
import { registerNotificationRoutes } from './routes/notifications.js'
import { registerInstanceRoutes } from './routes/instances.js'
import { registerCronJobRoutes } from './routes/cron-jobs.js'
import { registerBackupRoutes } from './routes/backup.js'
import { registerChannelRoutes } from './routes/channels.js'
import { registerMemorySpacesRoutes } from './routes/memory-spaces.js'
import { registerFileWatcherRoutes } from './routes/file-watchers.js'
import { registerMetricsRoutes } from './routes/metrics.js'
import { registerFileRoutes } from './routes/files.js'
import { addClient, broadcast, startHeartbeat } from './ws.js'
import { getMcpManager } from './core/tools/mcp/mcp-manager.js'
import { getEmbeddingProvider } from './core/memory/embedding.js'
import { startCronScheduler, stopCronScheduler } from './core/triggers/cron-scheduler.js'
import { startFileWatcherService, stopFileWatcherService } from './core/triggers/file-watcher.js'
import { registerBuiltInTools } from './core/tools/built-in-tools.js'
import { getChannelManager } from './core/channels/channel-manager.js'

const APP_NAME = 'cynosure-server'
const APP_VERSION = process.env.CYNOSURE_VERSION || '1.0.0'
const DEFAULT_PORT = 3099

const executionEvents = [
  'task:started',
  'task:completed',
  'task:error',
  'step:status',
  'step:thinking',
  'step:content',
  'step:choosing-chunk',
  'step:tools-chosen',
  'step:executed',
  'step:hitl-denied',
  'step:error',
  'error:retry',
  'agent:delegating'
] as const

interface CliOptions {
  host?: string
  port?: number
  dataDir?: string
  showHelp: boolean
  showVersion: boolean
}

interface StartServerOptions {
  host?: string
  port: number
  dataDir?: string
}

interface RunningServer {
  close: () => Promise<void>
}

function parsePort(value: string, source: string): number {
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${source} '${value}'. Expected an integer between 1 and 65535.`)
  }
  return port
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    showHelp: false,
    showVersion: false
  }

  const readValue = (flag: string, index: number): [string, number] => {
    const next = argv[index + 1]
    if (!next) {
      throw new Error(`Missing value for ${flag}.`)
    }
    return [next, index + 1]
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      options.showHelp = true
      continue
    }

    if (arg === '--version' || arg === '-v') {
      options.showVersion = true
      continue
    }

    if (arg === '--host') {
      [options.host, index] = readValue(arg, index)
      continue
    }

    if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length)
      continue
    }

    if (arg === '--port') {
      const value = readValue(arg, index)
      options.port = parsePort(value[0], 'port')
      index = value[1]
      continue
    }

    if (arg.startsWith('--port=')) {
      options.port = parsePort(arg.slice('--port='.length), 'port')
      continue
    }

    if (arg === '--data-dir') {
      [options.dataDir, index] = readValue(arg, index)
      continue
    }

    if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length)
      continue
    }

    throw new Error(`Unknown argument '${arg}'. Run '${APP_NAME} --help' for usage.`)
  }

  return options
}

function printHelp(): void {
  const executable = basename(process.argv[1] || APP_NAME)
  console.log(`${APP_NAME} ${APP_VERSION}

Usage:
  ${executable} [options]

Options:
  -h, --help             Show this help text
  -v, --version          Show the CLI version
  --host <host>          Bind to a specific host (default: env HOST or all interfaces)
  --port <port>          Bind to a specific port (default: env PORT or ${DEFAULT_PORT})
  --data-dir <path>      Override CYNOSURE_DATA_DIR for SQLite, LanceDB, and logs

Examples:
  ${executable}
  ${executable} --port 4000
  ${executable} --host 127.0.0.1 --port 4000 --data-dir ./data
`)
}

function resolvePort(cliPort?: number): number {
  if (cliPort != null) {
    return cliPort
  }

  const rawPort = process.env.PORT
  if (!rawPort) {
    return DEFAULT_PORT
  }

  return parsePort(rawPort, 'PORT environment variable')
}

function formatListenAddress(host: string | undefined, port: number): string {
  return host ? `http://${host}:${port}` : `http://localhost:${port}`
}

async function startServer(options: StartServerOptions): Promise<RunningServer> {
  if (options.dataDir) {
    process.env.CYNOSURE_DATA_DIR = options.dataDir
  }

  const app = Fastify({ bodyLimit: 50 * 1024 * 1024 })

  await app.register(fastifyCors)
  await app.register(fastifyWebsocket)

  // Swagger API documentation
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Cynosure API',
        version: APP_VERSION,
        description: 'LLM orchestrator with tools, agents, and memory'
      }
    }
  })
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' })

  const pendingHITLResolvers = new Map<string, (result: ApprovalResult) => void>()

  // WebSocket route
  app.register(async (wsApp) => {
    wsApp.get('/ws', { websocket: true }, (socket) => {
      const ws = socket as unknown as WebSocket
      addClient(ws)

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            event: string
            data: Record<string, unknown>
          }

          if (msg.event !== 'hitl:response') {
            return
          }

          const { taskId, approved, reason, approvalType, conversationId, toolNames } = msg.data as {
            taskId: string
            approved: boolean
            reason?: string
            approvalType?: 'once' | 'session' | 'always'
            conversationId?: string
            toolNames?: string[]
          }
          const resolver = pendingHITLResolvers.get(taskId)
          if (!resolver) {
            return
          }

          if (approvalType === 'session' && conversationId && toolNames?.length) {
            getHITLGate().addSessionApproval(conversationId, toolNames)
          }

          resolver({ approved, reason })
          pendingHITLResolvers.delete(taskId)
          // Remove from persistence now that it is resolved
          getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId)
        } catch {
          // Ignore malformed messages.
        }
      })
    })
  })

  const heartbeat = startHeartbeat()
  const eventBus = getEventBus()

  const hitlRequestListener = (...args: unknown[]) => {
    const data = args[0] as {
      taskId: string
      conversationId?: string
      toolCalls: Array<{
        id: string
        type: string
        function: { name: string; arguments: string }
      }>
      resolve: (result: ApprovalResult) => void
    }

    pendingHITLResolvers.set(data.taskId, data.resolve)

    // Persist to DB so the client can restore after a hard reload
    getDb().prepare(
      'INSERT OR REPLACE INTO pending_hitl (task_id, conversation_id, tool_calls_json, created_at) VALUES (?, ?, ?, ?)'
    ).run(
      data.taskId,
      data.conversationId || '',
      JSON.stringify(data.toolCalls.map((tc) => ({ name: tc.function.name, arguments: tc.function.arguments }))),
      Date.now()
    )

    broadcast('agent:hitl-request', {
      taskId: data.taskId,
      conversationId: data.conversationId,
      toolCalls: data.toolCalls.map((toolCall) => ({
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
      }))
    })
  }

  const removeHitlRequestListener = eventBus.on('hitl:request', hitlRequestListener)

  // Clean up pending HITL resolvers when resolved externally (e.g. via Telegram buttons)
  const removeHitlResolvedListener = eventBus.on('hitl:resolved', (...args: unknown[]) => {
    const data = args[0] as { taskId: string }
    pendingHITLResolvers.delete(data.taskId)
  })

  const executionListenerCleanups = executionEvents.map((eventName) => {
    const listener = (data: unknown) => {
      broadcast('agent:execution-update', { event: eventName, data })
    }
    return eventBus.on(eventName, listener)
  })

  // Persist execution steps to DB for reload survival
  const stepPersistenceCleanups = setupExecutionStepPersistence(eventBus)

  app.register(registerProviderRoutes, { prefix: '/api/providers' })
  app.register(async (instance) => registerChatRoutes(instance, broadcast), { prefix: '/api/chat' })
  app.register(registerConversationRoutes, { prefix: '/api/chat' })
  app.register(registerAgentDefinitionRoutes, { prefix: '/api/agents' })
  app.register(async (instance) => registerMemoryRoutes(instance, broadcast), { prefix: '/api/memory' })
  app.register(registerMcpRoutes, { prefix: '/api/mcp' })
  app.register(async (instance) => registerNotificationRoutes(instance, broadcast), { prefix: '/api/notifications' })
  app.register(registerInstanceRoutes, { prefix: '/api/instances' })
  app.register(registerCronJobRoutes, { prefix: '/api/cron-jobs' })
  app.register(registerBackupRoutes, { prefix: '/api/backup' })
  app.register(registerChannelRoutes, { prefix: '/api/channels' })
  app.register(registerMemorySpacesRoutes, { prefix: '/api/memory-spaces' })
  app.register(registerFileWatcherRoutes, { prefix: '/api/file-watchers' })
  app.register(registerMetricsRoutes, { prefix: '/api/metrics' })
  app.register(registerFileRoutes, { prefix: '/api/files' })

  app.get('/api/health', async () => {
    return { status: 'ok' }
  })

  loadSavedProviders()
  getEmbeddingProvider().loadFromDb()
  await getRAGStore().initialize()
  registerBuiltInTools()

  // Set the server base URL so MCP HTTP transport can construct OAuth callback URLs
  getMcpManager().setServerBaseUrl(`http://127.0.0.1:${options.port}`)
  await loadSavedMcpServers()
  startCronScheduler(broadcast)
  startFileWatcherService(broadcast)

  // Start messaging channels (Telegram, etc.)
  const channelManager = getChannelManager()
  channelManager.setBroadcast(broadcast)
  await channelManager.loadAll()

  await app.listen({ port: options.port, host: options.host || '0.0.0.0' })

  console.log(`Cynosure server listening on ${formatListenAddress(options.host, options.port)}`)

  let isClosed = false

  return {
    close: async () => {
      if (isClosed) {
        return
      }
      isClosed = true

      clearInterval(heartbeat)
      removeHitlRequestListener()
      removeHitlResolvedListener()
      for (const cleanup of executionListenerCleanups) {
        cleanup()
      }
      for (const cleanup of stepPersistenceCleanups) {
        cleanup()
      }
      stopCronScheduler()
      stopFileWatcherService()
      await getChannelManager().stopAll()

      await app.close()

      closeDb()
      await getRAGStore().close()
      await getMcpManager().disconnectAll()
    }
  }
}

type EventBusType = ReturnType<typeof getEventBus>

function setupExecutionStepPersistence(eventBus: EventBusType): Array<() => void> {
  const db = getDb()
  const insertStep = db.prepare(
    `INSERT INTO execution_steps (id, conversation_id, task_id, iteration, status, message, plan, tool_calls_json, results_json, evaluation_json, ma_codename, ma_agent_name, ma_phase, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  // Track last step id per task for updates (keyed by taskId to avoid sub-agent collisions)
  const lastStepIds = new Map<string, string>()

  function stepKey(convId: string, taskId?: string): string {
    return taskId ? `${convId}:${taskId}` : convId
  }

  function saveStep(convId: string, iteration: number, status: string, extra: Record<string, unknown> = {}): string {
    const id = nanoid()
    const taskId = (extra.taskId as string) || null
    insertStep.run(
      id,
      convId,
      taskId,
      iteration,
      status,
      (extra.message as string) || null,
      (extra.plan as string) || null,
      extra.toolCalls ? JSON.stringify(extra.toolCalls) : null,
      extra.results ? JSON.stringify(extra.results) : null,
      extra.evaluation ? JSON.stringify(extra.evaluation) : null,
      (extra.maCodename as string) || null,
      (extra.maAgentName as string) || null,
      (extra.maPhase as string) || null,
      Date.now()
    )
    lastStepIds.set(stepKey(convId, taskId || undefined), id)
    return id
  }

  const updateStep = db.prepare(
    `UPDATE execution_steps SET plan = COALESCE(?, plan), tool_calls_json = COALESCE(?, tool_calls_json), results_json = COALESCE(?, results_json), evaluation_json = COALESCE(?, evaluation_json) WHERE id = ?`
  )

  function patchLastStep(convId: string, taskId: string | undefined, patch: Record<string, unknown>): void {
    const sid = lastStepIds.get(stepKey(convId, taskId))
    if (!sid) return
    updateStep.run(
      patch.plan as string || null,
      patch.toolCalls ? JSON.stringify(patch.toolCalls) : null,
      patch.results ? JSON.stringify(patch.results) : null,
      patch.evaluation ? JSON.stringify(patch.evaluation) : null,
      sid
    )
  }

  const cleanups: Array<() => void> = []

  // Regular agent events
  cleanups.push(eventBus.on('step:status', (data: unknown) => {
    const d = data as Record<string, unknown>
    const convId = d.conversationId as string
    if (!convId) return
    saveStep(convId, d.iteration as number, d.status as string, {
      message: d.message,
      taskId: d.taskId,
      maCodename: d.maCodename,
      maAgentName: d.maAgentName,
    })
  }))

  cleanups.push(eventBus.on('step:tools-chosen', (data: unknown) => {
    const d = data as Record<string, unknown>
    const convId = d.conversationId as string
    if (!convId) return
    patchLastStep(convId, d.taskId as string | undefined, { toolCalls: d.toolCalls })
  }))

  cleanups.push(eventBus.on('step:executed', (data: unknown) => {
    const d = data as Record<string, unknown>
    const convId = d.conversationId as string
    if (!convId) return
    patchLastStep(convId, d.taskId as string | undefined, { results: d.results })
  }))

  return cleanups
}

async function runCli(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2))

  if (options.showVersion) {
    console.log(APP_VERSION)
    return
  }

  if (options.showHelp) {
    printHelp()
    return
  }

  const runtime = await startServer({
    host: options.host || process.env.HOST,
    port: resolvePort(options.port),
    dataDir: options.dataDir
  })

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    console.log(`\nReceived ${signal}, shutting down...`)
    try {
      await runtime.close()
      process.exit(0)
    } catch (error) {
      console.error('Failed to shut down cleanly:', error)
      process.exit(1)
    }
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

runCli().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
