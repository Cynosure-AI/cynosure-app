import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  speak: vi.fn(),
}))

vi.mock('../../api/client', () => ({ api: { tts: { speak: mocks.speak } } }))

import MessageBubble from './MessageBubble.vue'
import { useVoiceOutputStore } from '../../stores/voice-output.store'
import { useSpeechPlayer } from '../../composables/useSpeechPlayer'

function mountMessage(role: 'user' | 'assistant') {
  const router = createRouter({ history: createMemoryHistory(), routes: [] })
  return mount(MessageBubble, {
    props: { role, content: 'First sentence. Second **one**.', messageId: 'm1' },
    global: { plugins: [router], stubs: { Icon: true } },
  })
}

describe('MessageBubble read aloud', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Synthesis stays pending, so the message keeps "speaking".
    mocks.speak.mockReset().mockReturnValue(new Promise(() => {}))
  })

  test('offers read aloud on replies once a voice is chosen', () => {
    expect(mountMessage('assistant').find('[data-testid="read-aloud"]').exists()).toBe(false)

    useVoiceOutputStore().settings = { enabled: true, voiceId: 'en_GB-aru-medium', speakerId: 0, speed: 1, autoRead: 'voice' }

    expect(mountMessage('assistant').find('[data-testid="read-aloud"]').exists()).toBe(true)
    expect(mountMessage('user').find('[data-testid="read-aloud"]').exists()).toBe(false)
  })

  test('reads the reply sentence by sentence and stops on a second click', async () => {
    useVoiceOutputStore().settings = { enabled: true, voiceId: 'en_GB-aru-medium', speakerId: 0, speed: 1, autoRead: 'voice' }
    const wrapper = mountMessage('assistant')
    const button = wrapper.get('[data-testid="read-aloud"]')

    await button.trigger('click')
    await nextTick()

    expect(mocks.speak).toHaveBeenCalledWith('First sentence.', {}, expect.any(AbortSignal))
    expect(mocks.speak).toHaveBeenCalledWith('Second one.', {}, expect.any(AbortSignal))
    expect(button.attributes('title')).toBe('Stop reading')

    await button.trigger('click')
    await vi.waitFor(() => expect(useSpeechPlayer().state.phase).toBe('idle'))
    expect(button.attributes('title')).toBe('Read aloud')
  })
})
