import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createStartupStatus } from './startup-status.js'

afterEach(() => vi.useRealTimers())

describe('startup readiness', () => {
  test('serves progress and the UI while rejecting API writes and WebSocket upgrades until ready', async () => {
    const app = Fastify()
    const startup = createStartupStatus(app)
    const write = vi.fn(() => ({ saved: true }))
    await app.register(fastifyWebsocket)
    app.get('/api/health', async (_request, reply) =>
      reply.code(startup.ready ? 200 : 503).send({ startupProgress: startup.snapshot() }))
    app.get('/', async () => 'Web UI')
    app.post('/api/settings', write)
    app.get('/ws', { websocket: true }, socket => socket.close())
    try {
      startup.stage('mcp', 'Connecting MCP servers…')
      expect((await app.inject('/')).body).toBe('Web UI')
      const health = await app.inject('/api/health?poll=1')
      expect(health.statusCode).toBe(503)
      expect(health.json().startupProgress.phase).toBe('mcp')
      const blocked = await app.inject({ method: 'POST', url: '/api/settings?value=1' })
      expect(blocked.statusCode).toBe(503)
      expect(blocked.headers['retry-after']).toBe('1')
      expect(write).not.toHaveBeenCalled()
      const upgrade = () => app.inject({ url: '/ws', headers: {
        connection: 'upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      } })
      expect((await upgrade()).statusCode).toBe(503)
      startup.stage('ready', 'Ready')
      expect((await app.inject('/api/health')).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/settings' })).statusCode).toBe(200)
      expect(write).toHaveBeenCalledOnce()
      const socket = await app.injectWS('/ws')
      socket.close()
    } finally {
      await app.close()
    }
  })

  test('times active MCPs independently and freezes completed timings', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const app = Fastify()
    const startup = createStartupStatus(app)
    startup.mcpServer({ id: 'slow', name: 'Slow server', status: 'connecting', elapsedMs: 0 })
    startup.mcpServer({ id: 'fast', name: 'Fast server', status: 'connecting', elapsedMs: 0 })
    vi.setSystemTime(1000)
    startup.mcpServer({ id: 'fast', name: 'Fast server', status: 'connected', elapsedMs: 1000, toolCount: 4 })
    vi.setSystemTime(5000)
    expect(startup.snapshot().mcpServers).toEqual([
      { id: 'slow', name: 'Slow server', status: 'connecting', elapsedMs: 5000 },
      { id: 'fast', name: 'Fast server', status: 'connected', elapsedMs: 1000, toolCount: 4 },
    ])
    startup.mcpServer({ id: 'slow', name: 'Slow server', status: 'error', elapsedMs: 5000 })
    startup.stage('ready', 'Ready')
    vi.setSystemTime(9000)
    expect(startup.snapshot().elapsedMs).toBe(5000)
    expect(startup.snapshot().mcpServers[0].elapsedMs).toBe(5000)
    await app.close()
  })
})
