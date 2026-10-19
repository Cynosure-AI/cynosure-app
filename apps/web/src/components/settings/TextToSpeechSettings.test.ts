import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PiperVoice } from '@shared/types'

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  updateSettings: vi.fn(),
  voices: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    tts: {
      getSettings: vi.fn(),
      updateSettings: mocks.updateSettings,
      voices: mocks.voices,
      remove: mocks.remove,
      onDownloadProgress: () => () => {},
      speak: vi.fn(),
    },
  },
}))

import TextToSpeechSettings from './TextToSpeechSettings.vue'
import { useVoiceOutputStore } from '../../stores/voice-output.store'

function voice(id: string, name: string): PiperVoice {
  return { id, name, languageCode: 'en_GB', languageName: 'English', countryName: 'Great Britain', quality: 'medium', numSpeakers: 1, sizeBytes: 77_000_000, installed: true }
}

async function mountSettings() {
  const store = useVoiceOutputStore()
  store.settings = { enabled: true, voiceId: 'en_GB-aru-medium', speakerId: 0, speed: 1, autoRead: 'voice' }
  const wrapper = mount(TextToSpeechSettings, {
    props: { visibleSections: ['voice-library'] },
    global: { stubs: { Icon: true, Teleport: true } },
  })
  await flushPromises()
  return { wrapper, store }
}

describe('TextToSpeechSettings deleting voices', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.voices.mockResolvedValue({ voices: [voice('en_GB-aru-medium', 'aru'), voice('en_GB-alan-medium', 'alan')], downloads: [] })
    mocks.remove.mockResolvedValue({ deleted: true })
    mocks.updateSettings.mockImplementation(async (changes) => ({ ...useVoiceOutputStore().settings, ...changes }))
  })

  test('deletes a library voice after confirmation, keeping Cyno speaking', async () => {
    const { wrapper, store } = await mountSettings()

    await wrapper.get('button[aria-label="Delete Aru"]').trigger('click')
    expect(wrapper.text()).toContain('will speak with Alan instead')
    expect(mocks.remove).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="confirm-delete-voice"]').trigger('click')
    await flushPromises()

    expect(mocks.remove).toHaveBeenCalledWith('en_GB-aru-medium')
    expect(mocks.updateSettings).toHaveBeenCalledWith({ voiceId: 'en_GB-alan-medium', speakerId: 0 })
    expect(store.settings?.voiceId).toBe('en_GB-alan-medium')
    expect(wrapper.find('button[aria-label="Delete Aru"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Delete Alan"]').exists()).toBe(true)
  })

  test('cancel keeps the voice', async () => {
    const { wrapper } = await mountSettings()

    await wrapper.get('button[aria-label="Delete Alan"]').trigger('click')
    await wrapper.findAll('button').find((button) => button.text() === 'Cancel')!.trigger('click')

    expect(mocks.remove).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="confirm-delete-voice"]').exists()).toBe(false)
  })
})
