import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: { userSettings: apiMocks },
}))

vi.mock('../utils/electron-prefs', () => ({
  syncPrefsToElectron: vi.fn(),
}))

import { usePreferencesStore } from './preferences.store'

describe('preferences profile', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  test('loads the user name and avatar together', async () => {
    apiMocks.get.mockResolvedValue({ name: 'Ada', avatarUrl: 'data:image/webp;base64,AAAA' })
    const store = usePreferencesStore()

    await store.loadUserSettings()

    expect(store.userName).toBe('Ada')
    expect(store.userAvatarUrl).toBe('data:image/webp;base64,AAAA')
    expect(store.userSettingsLoaded).toBe(true)
  })

  test('persists profile changes as one consistent profile', async () => {
    apiMocks.update.mockResolvedValue({ name: 'Grace', avatarUrl: null })
    const store = usePreferencesStore()
    store.userName = ' Grace '
    store.userAvatarUrl = null

    await store.saveUserProfile()

    expect(apiMocks.update).toHaveBeenCalledWith({ name: ' Grace ', avatarUrl: null })
    expect(store.userName).toBe('Grace')
    expect(store.userAvatarUrl).toBeNull()
  })
})
