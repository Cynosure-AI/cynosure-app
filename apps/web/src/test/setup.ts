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

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
