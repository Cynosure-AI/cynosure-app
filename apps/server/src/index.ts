#!/usr/bin/env node
import { startDreamWorker } from './core/memory/dream-worker.js'

import 'dotenv/config'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import fastifyStatic from '@fastify/static'
import packageJson from '../package.json' with { type: 'json' }
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'net'
import type { WebSocket } from 'ws'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { closeDb, getDb } from './db/database.js'
import { type ApprovalResult, getHITLGate } from './core/agent/hitl-gate.js'
import { getRAGStore } from './core/memory/rag.js'
import { getEventBus } from './core/telemetry/event-bus.js'
import type { ToolBehaviorAnnotations } from './core/gateway/providers/base.provider.js'

import { registerAgentDefinitionRoutes } from './routes/agents.js'
import { registerChatRoutes } from './routes/chat.js'
import { registerConversationRoutes } from './routes/conversations.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerMcpRoutes, loadSavedMcpServers } from './routes/mcp/index.js'
import { registerProviderRoutes, loadSavedProviders } from './routes/providers.js'
import { registerNotificationRoutes } from './routes/notifications.js'
import { registerInstanceRoutes } from './routes/instances.js'
import { registerActivityRoutes } from './routes/activity.js'
import { registerCronJobRoutes } from './routes/cron-jobs.js'
import { registerBackupRoutes } from './routes/backup.js'
import { registerChannelRoutes } from './routes/channels.js'
import { registerMemoryFoldersRoutes } from './routes/memory-folders.js'
import { stopAllMemoryFolderWatchers } from './core/memory/memory-folder-watcher.js'
import { ensureDefaultMemoryFolders, syncMemoryFoldersFromFolders } from './core/memory/memory-folder-directories.js'
import { registerMetricsRoutes } from './routes/metrics.js'
import { registerFileRoutes } from './routes/files.js'
import { registerFileAccessRoutes } from './routes/file-access.js'
import { registerUserSettingsRoutes } from './routes/user-settings.js'
import { registerModelFavoritesRoutes } from './routes/model-favorites.js'
import { addClient, broadcast, setClientConversationSubscriptions, startHeartbeat } from './ws.js'
import { executionUpdateToChatPayload, publishChatEvent } from './core/chat/transcript.js'
import { getMcpManager } from './core/tools/mcp/mcp-manager.js'
import { loadEmbeddingServiceFromDb } from './core/memory/embedding.js'
import { startToolEmbeddingWarmup } from './core/agent/tool-embedding-warmup.js'
import { startCronScheduler, stopCronScheduler } from './core/triggers/cron-scheduler.js'
import { registerBuiltInTools } from './core/tools/built-in-tools.js'
import { getChannelManager } from './core/channels/channel-manager.js'

const APP_NAME = 'cynosure-server'
const APP_VERSION = packageJson.version
const DEFAULT_PORT = 3099
const __dirname = dirname(fileURLToPath(import.meta.url))

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

async function assertPortAvailable(port: number, host: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use on ${host}. Stop the existing Cynosure server or start this instance with --port <number>.`,
        ))
        return
      }
      reject(error)
    })
    probe.listen(port, host, () => {
      probe.close((error) => error ? reject(error) : resolvePromise())
    })
  })
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

function getServerInfo(startedAt: string): Record<string, unknown> {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    status: 'ok',
    description: 'Cynosure server is running.',
    timestamp: new Date().toISOString(),
    startedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    endpoints: {
      health: '/api/health',
      docs: '/docs',
      websocket: '/ws',
      api: '/api'
    }
  }
}

function resolveWebDist(): string | null {
  const candidates = [
    process.env.CYNOSURE_WEB_DIST,
    resolve(__dirname, '../../web/dist'),
    resolve(process.cwd(), '../web/dist'),
    resolve(process.cwd(), 'web/dist')
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate
    }
  }

  return null
}

function shouldServeSpa(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false
  }

  const pathname = new URL(request.url, 'http://localhost').pathname
  if (pathname.startsWith('/api') || pathname.startsWith('/docs') || pathname === '/ws') {
    return false
  }

  const accept = request.headers.accept || ''
  return accept.includes('text/html') || accept.includes('*/*')
}

async function registerWebUi(app: FastifyInstance, startedAt: string): Promise<void> {
  const webDist = resolveWebDist()

  app.get('/api', async () => getServerInfo(startedAt))

  if (!webDist) {
    app.get('/', async () => getServerInfo(startedAt))
    app.log.warn('Web UI dist not found. Build cynosure-web or set CYNOSURE_WEB_DIST to serve the UI at /.')
    return
  }

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    decorateReply: false
  })

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (!shouldServeSpa(request)) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Route ${request.method}:${request.url} not found`,
        statusCode: 404
      })
    }

    const html = await readFile(join(webDist, 'index.html'), 'utf8')
    return reply.type('text/html; charset=utf-8').send(html)
  })
}

/** Seed starter folders on first launch, then start filesystem watchers for all memory folders. */
function startMemoryFolderWatchers(): void {
  const db = getDb()
  ensureDefaultMemoryFolders(db)
  syncMemoryFoldersFromFolders(db)
}

async function startServer(options: StartServerOptions): Promise<RunningServer> {
  if (options.dataDir) {
    process.env.CYNOSURE_DATA_DIR = options.dataDir
  }

  const listenHost = options.host || '0.0.0.0'
  // Fail before opening the database, starting watchers, or spawning configured
  // MCP/channel processes when this server can never acquire its listen port.
  await assertPortAvailable(options.port, listenHost)

  const startedAt = new Date().toISOString()
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

          if (msg.event === 'client:subscribe-conversations') {
            const rawIds = msg.data?.conversationIds
            const conversationIds = Array.isArray(rawIds)
              ? rawIds.filter((id): id is string => typeof id === 'string')
              : []
            setClientConversationSubscriptions(ws, conversationIds)
            return
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
          getHITLGate().clearExternalRequest(taskId)
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
        annotations?: ToolBehaviorAnnotations
        fileAccess?: { path: string; folder: string; toolName: string }
      }>
      resolve: (result: ApprovalResult) => void
    }

    pendingHITLResolvers.set(data.taskId, data.resolve)
    if (data.conversationId && data.toolCalls.some((toolCall) => toolCall.fileAccess)) {
      getHITLGate().trackExternalRequest(data.taskId, data.conversationId)
    }

    // Persist to DB so the client can restore after a hard reload
    getDb().prepare(
      'INSERT OR REPLACE INTO pending_hitl (task_id, conversation_id, tool_calls_json, created_at) VALUES (?, ?, ?, ?)'
    ).run(
      data.taskId,
      data.conversationId || '',
      JSON.stringify(data.toolCalls.map((tc) => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
        annotations: tc.annotations,
        fileAccess: tc.fileAccess,
      }))),
      Date.now()
    )

    broadcast('agent:hitl-request', {
      taskId: data.taskId,
      conversationId: data.conversationId,
      toolCalls: data.toolCalls.map((toolCall) => ({
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
        annotations: toolCall.annotations,
        fileAccess: toolCall.fileAccess,
      }))
    })
  }

  const removeHitlRequestListener = eventBus.on('hitl:request', hitlRequestListener)

  // Clean up pending HITL resolvers when resolved externally (e.g. via Telegram buttons)
  const removeHitlResolvedListener = eventBus.on('hitl:resolved', (...args: unknown[]) => {
    const data = args[0] as { taskId: string }
    pendingHITLResolvers.delete(data.taskId)
    getHITLGate().clearExternalRequest(data.taskId)
  })
  const removeHitlCancelRequestListener = eventBus.on('hitl:cancel-request', (...args: unknown[]) => {
    const data = args[0] as { taskId: string; conversationId: string }
    pendingHITLResolvers.delete(data.taskId)
    getHITLGate().clearExternalRequest(data.taskId)
    getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(data.taskId)
    broadcast('agent:hitl-resolved', { taskId: data.taskId, conversationId: data.conversationId, cancelled: true })
  })
  const removeHitlClearConversationListener = eventBus.on('hitl:clear-conversation', (...args: unknown[]) => {
    const data = args[0] as { conversationId?: string }
    if (!data.conversationId) return

    const rows = getDb()
      .prepare('SELECT task_id FROM pending_hitl WHERE conversation_id = ?')
      .all(data.conversationId) as { task_id: string }[]

    const taskIds = new Set<string>(rows.map((row) => row.task_id))
    for (const taskId of getHITLGate().clearPendingForConversation(data.conversationId)) {
      taskIds.add(taskId)
    }

    getDb().prepare('DELETE FROM pending_hitl WHERE conversation_id = ?').run(data.conversationId)

    for (const taskId of taskIds) {
      pendingHITLResolvers.delete(taskId)
      broadcast('agent:hitl-resolved', {
        taskId,
        conversationId: data.conversationId,
        cancelled: true
      })
    }
  })

  const executionListenerCleanups = executionEvents.map((eventName) => {
    const listener = (data: unknown) => {
      const step = data && typeof data === 'object' ? data as Record<string, unknown> : null
      const payload = step && executionUpdateToChatPayload(eventName, step)
      if (payload && typeof step?.conversationId === 'string') {
        publishChatEvent(broadcast, { conversationId: step.conversationId,
          executionId: typeof step.executionId === 'string' ? step.executionId
            : typeof step.taskId === 'string' ? step.taskId : 'external', payload })
      } else {
        broadcast('agent:execution-update', { event: eventName, data })
      }
    }
    return eventBus.on(eventName, listener)
  })
  const removePlanningStateListener = eventBus.on('planning:state-updated', (data: unknown) => {
    broadcast('planning:state-updated', data)
  })
  const removeMemoryJobUpdatedListener = eventBus.on('memory:job-updated', (data: unknown) => {
    broadcast('memory:job-updated', data)
  })
  const removeKnowledgeResetListener = eventBus.on('memory:knowledge-reset', (data: unknown) => {
    broadcast('memory:knowledge-reset', data)
  })
  const removeChatExecutionStateListener = eventBus.on('chat:event', (data: unknown) => {
    broadcast('chat:event', data)
  })

  app.register(registerProviderRoutes, { prefix: '/api/providers' })
  app.register(async (instance) => registerChatRoutes(instance, broadcast), { prefix: '/api/chat' })
  app.register(registerConversationRoutes, { prefix: '/api/chat' })
  app.register(registerAgentDefinitionRoutes, { prefix: '/api/agents' })
  app.register(async (instance) => registerMemoryRoutes(instance, broadcast), { prefix: '/api/memory' })
  app.register(registerMcpRoutes, { prefix: '/api/mcp' })
  app.register(async (instance) => registerNotificationRoutes(instance, broadcast), { prefix: '/api/notifications' })
  app.register(registerInstanceRoutes, { prefix: '/api/instances' })
  app.register(registerActivityRoutes, { prefix: '/api/activity' })
  app.register(registerCronJobRoutes, { prefix: '/api/cron-jobs' })
  app.register(async (instance) => registerBackupRoutes(instance, broadcast), { prefix: '/api/backup' })
  app.register(registerChannelRoutes, { prefix: '/api/channels' })
  app.register(registerMemoryFoldersRoutes, { prefix: '/api/memory-folders' })
  app.register(registerMetricsRoutes, { prefix: '/api/metrics' })
  app.register(registerFileRoutes, { prefix: '/api/files' })
  app.register(registerFileAccessRoutes, { prefix: '/api/file-access' })
  app.register(registerUserSettingsRoutes, { prefix: '/api/user-settings' })
  app.register(registerModelFavoritesRoutes, { prefix: '/api/model-favorites' })

  app.get('/api/health', async () => {
    return {
      status: 'ok',
      name: APP_NAME,
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime())
    }
  })

  await registerWebUi(app, startedAt)

  loadSavedProviders()
  loadEmbeddingServiceFromDb()
  const ragStore = getRAGStore()
  await ragStore.initialize(undefined, { optimizeOnStartup: true })
  registerBuiltInTools()

  // Start filesystem watchers for all existing memory folders
  startMemoryFolderWatchers()

  // Set the server base URL so MCP HTTP transport can construct OAuth callback URLs
  getMcpManager().setServerBaseUrl(`http://127.0.0.1:${options.port}`)
  await loadSavedMcpServers()
  const stopToolEmbeddingWarmup = startToolEmbeddingWarmup()

  // Start messaging channels (Telegram, etc.) before cron catch-up runs so
  // startup-triggered jobs can deliver configured output notifications.
  const channelManager = getChannelManager()
  channelManager.setBroadcast(broadcast)
  await channelManager.loadAll()

  startCronScheduler(broadcast)
  const stopDreamWorker = startDreamWorker(broadcast)

  await app.listen({ port: options.port, host: listenHost })

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
      removeHitlCancelRequestListener()
      removeHitlClearConversationListener()
      for (const cleanup of executionListenerCleanups) {
        cleanup()
      }
      removePlanningStateListener()
      await stopToolEmbeddingWarmup()
      removeMemoryJobUpdatedListener()
      removeKnowledgeResetListener()
      removeChatExecutionStateListener()
      await stopDreamWorker()
      await stopCronScheduler()
      await getChannelManager().stopAll()
      await stopAllMemoryFolderWatchers()

      await app.close()

      closeDb()
      await getRAGStore().close()
      await getMcpManager().disconnectAll()
    }
  }
}

function isWindowsWatchPermissionError(error: unknown): boolean {
  if (process.platform !== 'win32' || !(error instanceof Error)) {
    return false
  }

  const err = error as NodeJS.ErrnoException
  return err.code === 'EPERM' && err.syscall === 'watch'
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

process.on('uncaughtException', (error) => {
  if (isWindowsWatchPermissionError(error)) {
    console.warn('Ignoring Windows filesystem watcher error:', error.message)
    return
  }

  throw error
})

runCli().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
