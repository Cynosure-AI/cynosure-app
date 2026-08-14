import { afterEach, describe, expect, test, vi } from 'vitest'
import { del, get, patch, post, put } from './http'

describe('HTTP client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('sends GET requests with cancellation and parses JSON responses', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(get<{ ok: boolean }>('/api/status', controller.signal)).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/status', {
      method: 'GET',
      signal: controller.signal,
    })
  })

  test.each([
    ['POST', post],
    ['PUT', put],
    ['PATCH', patch],
  ] as const)('serializes JSON bodies for %s', async (method, request) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(request('/api/resource', { value: 1 })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/resource', {
      method,
      signal: undefined,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    })
  })

  test('sends DELETE requests without an accidental body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"deleted":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(del('/api/resource')).resolves.toEqual({ deleted: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/resource', { method: 'DELETE', signal: undefined })
  })

  test.each([
    [{ error: 'explicit error' }, 'explicit error'],
    [{ message: 'provider unavailable' }, 'provider unavailable'],
  ])('uses structured API errors before generic status text', async (payload, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 503,
      statusText: 'Service Unavailable',
    })))

    await expect(get('/api/failure')).rejects.toThrow(message)
  })

  test('falls back to method, path, and status when an error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', {
      status: 500,
      statusText: 'Server Error',
    })))

    await expect(post('/api/failure')).rejects.toThrow('POST /api/failure: Server Error')
  })
})
