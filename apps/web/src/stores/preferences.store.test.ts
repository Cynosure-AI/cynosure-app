import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}))
const chatMocks = vi.hoisted(() => ({
  getRunSettings: vi.fn(),
  updateRunSettings: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: { userSettings: apiMocks, chat: chatMocks },
}))

vi.mock('../utils/electron-prefs', () => ({
  syncPrefsToElectron: vi.fn(),
}))

import { usePreferencesStore } from './preferences.store'
import { SK_COMPACT_MODEL, SK_COMPACT_PROVIDER, SK_CONTEXT_STRATEGY, SK_GENERATE_TITLE, SK_QUICK_RESPONSES, SK_RECENT_CHAT_FILTER, SK_SIDEBAR_CHAT_VIEW, SK_THEME } from '../utils/storage-keys'

describe('preferences profile', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
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

  test('saves instructions with the profile only after the saved profile has loaded', async () => {
    apiMocks.get.mockResolvedValue({ name: 'Ada', avatarUrl: null, instructions: 'Use allegories.' })
    apiMocks.update.mockImplementation(async (profile) => ({ name: 'Ada', avatarUrl: null, instructions: 'Use allegories.', ...profile }))
    const store = usePreferencesStore()

    await store.saveUserProfile()
    expect(apiMocks.update).toHaveBeenLastCalledWith({ name: '', avatarUrl: null })

    await store.loadUserSettings()
    expect(store.userInstructions).toBe('Use allegories.')
    store.userInstructions = 'Keep answers short.'
    await store.saveUserProfile()

    expect(apiMocks.update).toHaveBeenLastCalledWith({ name: 'Ada', avatarUrl: null, instructions: 'Keep answers short.' })
    expect(store.userInstructions).toBe('Keep answers short.')
  })

  test('restores and persists the recent chat filter', async () => {
    localStorage.setItem(SK_RECENT_CHAT_FILTER, JSON.stringify(['agents', 'cron']))
    const store = usePreferencesStore()

    expect(store.recentChatFilter).toEqual(['agents', 'cron'])

    store.recentChatFilter = ['all']
    await nextTick()
    expect(localStorage.getItem(SK_RECENT_CHAT_FILTER)).toBe(JSON.stringify(['all']))
  })

  test('defaults to global chats and persists the sidebar view', async () => {
    const store = usePreferencesStore()
    expect(store.sidebarChatView).toBe('global')

    store.sidebarChatView = 'agents'
    await nextTick()
    expect(localStorage.getItem(SK_SIDEBAR_CHAT_VIEW)).toBe('agents')
  })

  test.each(['global', 'agents'] as const)('restores the saved %s sidebar view', (view) => {
    localStorage.setItem(SK_SIDEBAR_CHAT_VIEW, view)
    expect(usePreferencesStore().sidebarChatView).toBe(view)
  })

  test('falls back to global chats for an unsupported saved view', async () => {
    localStorage.setItem(SK_SIDEBAR_CHAT_VIEW, 'unknown')
    const store = usePreferencesStore()
    await nextTick()

    expect(store.sidebarChatView).toBe('global')
    expect(localStorage.getItem(SK_SIDEBAR_CHAT_VIEW)).toBe('global')
  })

  test('replaces an unsupported persisted theme with the Crimson fallback', async () => {
    localStorage.setItem(SK_THEME, 'obsidian')

    const store = usePreferencesStore()
    await nextTick()

    expect(store.theme).toBe('crimson')
    expect(localStorage.getItem(SK_THEME)).toBe('crimson')
    expect(document.documentElement.dataset.theme).toBe('crimson')
  })

  test('migrates the retired VirtualBoy theme to Blackwall', async () => {
    localStorage.setItem(SK_THEME, 'virtualboy')

    const store = usePreferencesStore()
    await nextTick()

    expect(store.theme).toBe('blackwall')
    expect(localStorage.getItem(SK_THEME)).toBe('blackwall')
    expect(document.documentElement.dataset.theme).toBe('blackwall')
  })

  test('defaults to Crimson and toggles between Crimson and Light', () => {
    const store = usePreferencesStore()
    expect(store.theme).toBe('crimson')
    store.toggleTheme()
    expect(store.theme).toBe('light')
    store.toggleTheme()
    expect(store.theme).toBe('crimson')
  })

  test('preserves an existing Midnight theme preference', () => {
    localStorage.setItem(SK_THEME, 'dark')
    expect(usePreferencesStore().theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

})

describe('legacy chat run settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
  })

  test('copies deliberate browser choices to the server once and forgets them', async () => {
    localStorage.setItem(SK_COMPACT_PROVIDER, 'openai')
    localStorage.setItem(SK_COMPACT_MODEL, 'gpt-mini')
    localStorage.setItem(SK_CONTEXT_STRATEGY, 'sliding-window')
    localStorage.setItem(SK_GENERATE_TITLE, 'true')
    chatMocks.getRunSettings.mockResolvedValue({ saved: false })
    chatMocks.updateRunSettings.mockResolvedValue({ saved: true })

    await usePreferencesStore().migrateLegacyChatRunSettings()

    expect(chatMocks.updateRunSettings).toHaveBeenCalledWith({ compactProviderId: 'openai', compactModel: 'gpt-mini' })
    expect(localStorage.getItem(SK_COMPACT_MODEL)).toBeNull()
    expect(localStorage.getItem(SK_CONTEXT_STRATEGY)).toBeNull()
  })

  test('keeps server settings that were already saved', async () => {
    localStorage.setItem(SK_COMPACT_MODEL, 'gpt-mini')
    chatMocks.getRunSettings.mockResolvedValue({ saved: true })

    await usePreferencesStore().migrateLegacyChatRunSettings()

    expect(chatMocks.updateRunSettings).not.toHaveBeenCalled()
    expect(localStorage.getItem(SK_COMPACT_MODEL)).toBeNull()
  })

  test('carries a quick responses opt-in over even when other server settings were saved', async () => {
    localStorage.setItem(SK_QUICK_RESPONSES, 'true')
    localStorage.setItem(SK_COMPACT_MODEL, 'gpt-mini')
    chatMocks.getRunSettings.mockResolvedValue({ saved: true })
    chatMocks.updateRunSettings.mockResolvedValue({ saved: true })

    await usePreferencesStore().migrateLegacyChatRunSettings()

    expect(chatMocks.updateRunSettings).toHaveBeenCalledWith({ generateQuickResponses: true })
    expect(localStorage.getItem(SK_QUICK_RESPONSES)).toBeNull()
  })

  test('drops a quick responses opt-out without writing it, since off is the server default', async () => {
    localStorage.setItem(SK_QUICK_RESPONSES, 'false')
    chatMocks.getRunSettings.mockResolvedValue({ saved: true })

    await usePreferencesStore().migrateLegacyChatRunSettings()

    expect(chatMocks.updateRunSettings).not.toHaveBeenCalled()
    expect(localStorage.getItem(SK_QUICK_RESPONSES)).toBeNull()
  })

  test('does nothing without browser values', async () => {
    await usePreferencesStore().migrateLegacyChatRunSettings()
    expect(chatMocks.getRunSettings).not.toHaveBeenCalled()
  })
})
