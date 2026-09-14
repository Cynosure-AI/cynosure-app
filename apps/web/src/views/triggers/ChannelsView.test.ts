import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChannelDefinition } from '../../api/types'
import ChannelDetailView from './ChannelDetailView.vue'
import ChannelsView from './ChannelsView.vue'

const mocks = vi.hoisted(() => ({
  listChannels: vi.fn(),
  listAgents: vi.fn(),
  replace: vi.fn(),
  route: { query: {} as Record<string, string | undefined> },
}))

vi.mock('../../api/client', () => ({
  api: {
    agents: { list: mocks.listAgents },
    channels: {
      list: mocks.listChannels,
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
      testConfig: vi.fn(),
    },
  },
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
}))

const channel: ChannelDefinition = {
  id: 'channel-1',
  name: 'Support bot',
  type: 'telegram',
  agentId: 'agent-1',
  config: { botToken: 'token', allowedUserIds: ['123'] },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  status: { connected: true },
}

describe('ChannelsView editing', () => {
  beforeEach(() => {
    mocks.route.query = {}
    mocks.replace.mockReset()
    mocks.listChannels.mockReset().mockResolvedValue([channel])
    mocks.listAgents.mockReset().mockResolvedValue([])
  })

  test('opens and closes the channel editor in place without navigating', async () => {
    const wrapper = shallowMount(ChannelsView, { props: { embedded: true } })
    await flushPromises()

    await wrapper.get('[data-testid="channel-row"]').trigger('click')

    const editor = wrapper.getComponent(ChannelDetailView)
    expect(editor.props('channelId')).toBe('channel-1')
    expect(mocks.replace).not.toHaveBeenCalled()

    editor.vm.$emit('close')
    await flushPromises()

    expect(wrapper.findComponent(ChannelDetailView).exists()).toBe(false)
    expect(wrapper.find('[data-testid="channel-row"]').exists()).toBe(true)
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  test('opens a deep-linked channel inside settings', async () => {
    mocks.route.query = { channel: 'channel-1' }

    const wrapper = shallowMount(ChannelsView, { props: { embedded: true } })
    await flushPromises()

    expect(wrapper.getComponent(ChannelDetailView).props('channelId')).toBe('channel-1')
  })
})
