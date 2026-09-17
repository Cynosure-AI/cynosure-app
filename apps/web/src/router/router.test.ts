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

  test('exposes the library workspace route and redirects legacy artifact URLs', async () => {
    localStorage.setItem(SK_ONBOARDING_COMPLETE, 'true')
    const { default: router } = await import('./index')
    await router.push('/library')
    expect(router.currentRoute.value.name).toBe('library')
    expect(router.currentRoute.value.path).toBe('/library/generated')

    await router.push('/artifacts')
    expect(router.currentRoute.value.name).toBe('library')
    expect(router.currentRoute.value.path).toBe('/library/generated')

    await router.push('/artifacts/uploads')
    expect(router.currentRoute.value.name).toBe('library')
    expect(router.currentRoute.value.path).toBe('/library/uploads')
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

  test('keeps channel details inside the settings dialog', async () => {
    localStorage.setItem(SK_ONBOARDING_COMPLETE, 'true')
    const { default: router } = await import('./index')

    await router.push('/settings/channels/channel-1')

    expect(router.currentRoute.value.name).toBe('settings')
    expect(router.currentRoute.value.query).toMatchObject({
      category: 'channels',
      channel: 'channel-1',
    })
  })
})
