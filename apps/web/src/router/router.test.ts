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
    expect(router.currentRoute.value.path).toBe('/artifacts/generated')
  })

  test('uses clean canonical URLs for chat and scheduled jobs', async () => {
    localStorage.setItem(SK_ONBOARDING_COMPLETE, 'true')
    const { default: router } = await import('./index')

    await router.push('/chat/conversation-1')
    expect(router.currentRoute.value.name).toBe('conversation')
    expect(router.currentRoute.value.path).toBe('/chat/conversation-1')

    await router.push('/cron/job-1')
    expect(router.currentRoute.value.name).toBe('cron-detail')
    expect(router.currentRoute.value.path).toBe('/cron/job-1')
  })

  test('redirects legacy trigger-prefixed URLs to clean URLs', async () => {
    localStorage.setItem(SK_ONBOARDING_COMPLETE, 'true')
    const { default: router } = await import('./index')

    await router.push('/triggers/chat/conversation-1')
    expect(router.currentRoute.value.path).toBe('/chat/conversation-1')

    await router.push('/triggers/cron/job-1')
    expect(router.currentRoute.value.path).toBe('/cron/job-1')
  })
})
