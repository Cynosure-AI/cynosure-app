import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SK_ONBOARDING_COMPLETE } from '@/utils/storage-keys'

describe('router onboarding guard', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  test('redirects a new installation to onboarding', async () => {
    const { default: router } = await import('./index')
    await router.push('/settings')
    expect(router.currentRoute.value.name).toBe('onboarding')
  })

  test('allows normal navigation after onboarding is complete', async () => {
    localStorage.setItem(SK_ONBOARDING_COMPLETE, 'true')
    const { default: router } = await import('./index')
    await router.push('/settings')
    expect(router.currentRoute.value.name).toBe('settings')
  })

  test('exposes the artifacts workspace route', async () => {
    localStorage.setItem(SK_ONBOARDING_COMPLETE, 'true')
    const { default: router } = await import('./index')
    await router.push('/artifacts')
    expect(router.currentRoute.value.name).toBe('artifacts')
  })
})
