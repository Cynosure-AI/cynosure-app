import { afterEach, describe, expect, test, vi } from 'vitest'
import { checkServerHealth, useServerStartupError } from './useServerStartupError'

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
})
