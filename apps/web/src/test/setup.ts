import { afterEach, vi } from 'vitest'
import { enableAutoUnmount } from '@vue/test-utils'
import { Storage } from 'happy-dom'

enableAutoUnmount(afterEach)

// Iconify resolves uncached icons over the network. Icons are decorative in
// component unit tests, so replace the imported component at module level.
vi.mock('@iconify/vue', async () => {
  const { defineComponent } = await import('vue')
  return { Icon: defineComponent({ name: 'Icon', render: () => null }) }
})

// Node 25 exposes global localStorage/sessionStorage properties even when no
// valid --localstorage-file was configured. Vitest sees those properties and
// does not replace them with Happy DOM's Storage implementation, leaving an
// inert object without clear/getItem/setItem. Bind the browser-environment
// implementations explicitly when that happens.
function installBrowserStorage(name: 'localStorage' | 'sessionStorage'): void {
  const current = globalThis[name]
  if (typeof current?.clear === 'function') return

  const browserStorage = new Storage()

  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    value: browserStorage,
    writable: true,
  })

  if (window !== globalThis) {
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      value: browserStorage,
      writable: true,
    })
  }
}

installBrowserStorage('localStorage')
installBrowserStorage('sessionStorage')

// Unit tests must never reach a real server. Happy DOM resolves relative API
// URLs against http://localhost:3000, so an unmocked request would otherwise
// hit whatever runs there (possibly a real Cynosure install). Tests that need
// a response stub fetch themselves; anything else fails without a socket.
function blockedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  return Promise.reject(new TypeError(`Unmocked network request in a unit test: ${method} ${url}`))
}
Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: blockedFetch })
if (window !== globalThis) {
  Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: blockedFetch })
}

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
