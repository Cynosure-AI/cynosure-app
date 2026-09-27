import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import HITLDialog from './HITLDialog.vue'
import { useAgentStore } from '../../stores/agent-runtime.store'

describe('HITLDialog', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('labels and styles tools by their highest annotated effect', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAgentStore().handleHITLRequest({
      taskId: 'approval',
      toolCalls: [
        { name: 'inspect', arguments: '{}', annotations: { readOnlyHint: true, destructiveHint: false } },
        { name: 'update', arguments: '{}', annotations: { readOnlyHint: false, destructiveHint: false } },
        { name: 'remove', arguments: '{}', annotations: { readOnlyHint: true, destructiveHint: true } },
        { name: 'legacy', arguments: '{}' },
      ],
    })

    const wrapper = mount(HITLDialog, {
      global: {
        plugins: [pinia],
        stubs: { Icon: true },
      },
    })

    const cards = wrapper.findAll('.hitl-tool-card')
    expect(cards.map((card) => card.attributes('data-tool-effect'))).toEqual([
      'read', 'write', 'destructive', 'unknown',
    ])
    expect(wrapper.findAll('.hitl-tool-effect').map((badge) => badge.text())).toEqual([
      'Read', 'Write', 'Destructive', 'Unclassified',
    ])
    expect(cards[0].classes()).toContain('border-sky-500/30')
    expect(cards[1].classes()).toContain('border-amber-500/30')
    expect(cards[2].classes()).toContain('border-red-500/30')
    expect(wrapper.findAll('[data-content-kind="json"]')).toHaveLength(4)
  })

  test('shows the exact folder requested by a file access prompt', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const agent = useAgentStore()
    const response = vi.spyOn(agent, 'respondHITL').mockResolvedValue()
    agent.handleHITLRequest({
      taskId: 'file-permission',
      toolCalls: [{
        name: 'file_access_permission',
        arguments: '{}',
        fileAccess: { path: '/projects/private/report.txt', folder: '/projects/private', toolName: 'file_read' },
      }],
    })
    const wrapper = mount(HITLDialog, { global: { plugins: [pinia], stubs: { Icon: true } } })
    expect(wrapper.text()).toContain('/projects/private')
    expect(wrapper.text()).toContain('Allowing adds this folder')
    await wrapper.findAll('button').find(button => button.text() === 'Allow folder')!.trigger('click')
    expect(response).toHaveBeenCalledWith(true, undefined, 'once')
  })
})
