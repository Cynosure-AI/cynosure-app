import { afterEach, describe, expect, test, vi } from 'vitest'
import { checkServerHealth, useServerStartupError } from './useServerStartupError'
import { nextTick } from 'vue'
import { wsConnected } from '../api/http'

describe('useServerStartupError', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('surfaces the startup error from a failing health check', async () => {
    const startupError = { code: 'database_version_mismatch', message: 'too new', databaseVersion: 23, supportedVersion: 22 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'error', version: '1.0.0', startupError }),
      { status: 503 },
    )))

    const state = useServerStartupError()
    await checkServerHealth()

    expect(state.startupError.value).toEqual(startupError)
    expect(state.serverVersion.value).toBe('1.0.0')
  })

  test('clears the error once the server reports healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'ok', version: '1.0.1' }),
      { status: 200 },
    )))

    const state = useServerStartupError()
    await checkServerHealth()

    expect(state.startupError.value).toBeNull()
  })

  test('keeps waiting while the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(checkServerHealth()).resolves.toBeUndefined()
  })

  test('reads live progress from 503 without treating initialization as an error', async () => {
    const startupProgress = { phase: 'mcp', message: 'Connecting MCP servers…', elapsedMs: 12000,
      mcpServers: [{ id: 'files', name: 'Files', status: 'connecting', elapsedMs: 9000 }] }
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'starting', version: '1.0.1', startupProgress }), { status: 503 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const state = useServerStartupError()
    await checkServerHealth()
    expect(state.startupProgress.value).toEqual(startupProgress)
    expect(state.startupError.value).toBeNull()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' })))
    await checkServerHealth()
    expect(state.startupProgress.value).toBeNull()
  })

  test('polls while starting and stops once WebSocket connects', async () => {
    vi.useFakeTimers()
    const startupProgress = { phase: 'memory', message: 'Opening memory…', elapsedMs: 1000, mcpServers: [] }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ status: 'starting', startupProgress }), { status: 503 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const state = useServerStartupError()
    try {
      wsConnected.value = true
      await nextTick()
      wsConnected.value = false
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(state.startupProgress.value).toEqual(startupProgress)
      wsConnected.value = true
      await nextTick()
      expect(state.startupProgress.value).toBeNull()
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
