import type { FastifyInstance } from 'fastify'
import type { McpStartupServer, ServerStartupProgress } from '@shared/types'

/** Keep health and static assets reachable while APIs and WebSocket wait for readiness. */
export function createStartupStatus(app: FastifyInstance) {
  const startedAt = Date.now()
  let phase: ServerStartupProgress['phase'] = 'providers'
  let message = 'Loading providers and settings…'
  let finishedAt: number | undefined
  const servers = new Map<string, { server: McpStartupServer; startedAt: number }>()

  const snapshot = (): ServerStartupProgress => ({
    phase,
    message,
    elapsedMs: (finishedAt ?? Date.now()) - startedAt,
    mcpServers: [...servers.values()].map(({ server, startedAt }) => ({
      ...server,
      elapsedMs: server.status === 'connecting' ? Date.now() - startedAt : server.elapsedMs,
    })),
  })

  app.addHook('onRequest', async (request, reply) => {
    if (phase === 'ready') return
    const path = request.url.split('?')[0]
    if (path === '/api/health' || path.startsWith('/api/mcp/oauth/callback/')) return
    if (path === '/ws' || path === '/api' || path.startsWith('/api/')) {
      return reply.code(503).header('Retry-After', '1').send({
        error: 'Server is initializing', startupProgress: snapshot(),
      })
    }
  })

  return {
    snapshot,
    get ready() { return phase === 'ready' },
    stage(nextPhase: ServerStartupProgress['phase'], nextMessage: string) {
      phase = nextPhase
      message = nextMessage
      if (phase === 'ready') finishedAt = Date.now()
      console.log(`[startup] ${nextMessage} (${Date.now() - startedAt}ms)`)
    },
    mcpServer(server: McpStartupServer) {
      servers.set(server.id, { server: { ...server }, startedAt: Date.now() - server.elapsedMs })
    },
  }
}
