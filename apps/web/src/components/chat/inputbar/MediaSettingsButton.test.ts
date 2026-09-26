import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../../api/client'
import MediaSettingsButton from './MediaSettingsButton.vue'

describe('MediaSettingsButton', () => {
  afterEach(() => { vi.restoreAllMocks() })

  test('shows supported video values and emits an explicit choice', async () => {
    vi.spyOn(api.provider, 'listVideoModels').mockResolvedValue([{
      id: 'video-model', supported_durations: [4, 8], supported_resolutions: ['720p', '1080p'],
      supported_aspect_ratios: ['16:9'], supported_frame_images: ['first_frame', 'last_frame'],
    }])
    const wrapper = mount(MediaSettingsButton, {
      props: { kind: 'video', providerId: 'p1', model: 'video-model', value: null },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    await wrapper.get('button[aria-label="Video generation settings"]').trigger('click')
    expect(wrapper.text()).toContain('First and last frames')
    expect(wrapper.findAll('select')[0].findAll('option').map((option) => option.text())).toEqual(['Default', '720p', '1080p'])
    await wrapper.findAll('select')[2].setValue('8')
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toEqual({ kind: 'video', duration: 8 })
  })

  test('limits image count to the model capability', async () => {
    vi.spyOn(api.provider, 'listImageGenerationModels').mockResolvedValue([{
      id: 'image-model', supported_parameters: {
        resolution: { type: 'enum', values: ['1K', '2K'] },
        aspect_ratio: { type: 'enum', values: ['1:1'] },
        n: { type: 'range', min: 1, max: 2 },
      },
    }])
    const wrapper = mount(MediaSettingsButton, {
      props: { kind: 'image', providerId: 'p1', model: 'image-model', value: null },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()
    await wrapper.get('button[aria-label="Image generation settings"]').trigger('click')
    expect(wrapper.findAll('select')[2].findAll('option').map((option) => option.text())).toEqual(['Default', '1', '2'])
    await wrapper.findAll('select')[2].setValue('2')
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toEqual({ kind: 'image', n: 2 })
  })
})
