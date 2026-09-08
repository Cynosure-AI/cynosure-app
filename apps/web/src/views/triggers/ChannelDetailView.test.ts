import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChannelDefinition } from '../../api/types'
import SettingsPersistenceStatus from '../../components/settings/SettingsPersistenceStatus.vue'
import ModalDialog from '../../components/shared/ModalDialog.vue'
import ChannelDetailView from './ChannelDetailView.vue'

const mocks = vi.hoisted(() => ({
  getChannel: vi.fn(),
  updateChannel: vi.fn(),
  listAgents: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    agents: { list: mocks.listAgents },
    channels: {
      get: mocks.getChannel,
      update: mocks.updateChannel,
      testConfig: vi.fn(),
    },
  },
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

describe('ChannelDetailView persistence', () => {
  beforeEach(() => {
    mocks.getChannel.mockReset().mockResolvedValue(channel)
    mocks.updateChannel.mockReset()
    mocks.listAgents.mockReset().mockResolvedValue([{ id: 'agent-1', name: 'Agent' }])
  })

  test('reports dirty state and keeps the draft when saving fails', async () => {
    mocks.updateChannel.mockRejectedValue(new Error('offline'))
    const wrapper = shallowMount(ChannelDetailView, {
      props: { channelId: channel.id },
      global: { stubs: { BaseCard: false } },
    })
    await flushPromises()

    const saveButton = wrapper.findAll('button').find(button => button.text().includes('Save changes'))!
    expect(saveButton.attributes('disabled')).toBeDefined()

    const nameInput = wrapper.get('input[type="text"]')
    await nameInput.setValue('Renamed bot')

    expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([true])
    expect(saveButton.attributes('disabled')).toBeUndefined()

    await saveButton.trigger('click')
    await flushPromises()

    expect(mocks.updateChannel).toHaveBeenCalledOnce()
    expect((nameInput.element as HTMLInputElement).value).toBe('Renamed bot')
    expect(wrapper.getComponent(SettingsPersistenceStatus).props('state')).toBe('error')
    expect(wrapper.emitted('dirty-change')?.at(-1)).toEqual([true])
  })

  test('asks before closing a dirty editor', async () => {
    const wrapper = shallowMount(ChannelDetailView, {
      props: { channelId: channel.id },
      global: { stubs: { BaseCard: false } },
    })
    await flushPromises()

    await wrapper.get('input[type="text"]').setValue('Renamed bot')
    await wrapper.get('button[aria-label="Back to channels"]').trigger('click')

    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.getComponent(ModalDialog).props('show')).toBe(true)
  })
})
