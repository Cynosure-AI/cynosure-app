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
        arguments: JSON.stringify({ path: '/projects/private/report.txt', content: 'draft' }),
        fileAccess: { path: '/projects/private/report.txt', folder: '/projects/private', toolName: 'file_write' },
      }],
    })
    const wrapper = mount(HITLDialog, { global: { plugins: [pinia], stubs: { Icon: true } } })
    expect(wrapper.text()).toContain('/projects/private')
    expect(wrapper.text()).toContain('Allowing adds this folder')
    expect(wrapper.text()).toContain('draft')
    await wrapper.findAll('button').find(button => button.text() === 'Allow folder and run')!.trigger('click')
    expect(response).toHaveBeenCalledWith(true, undefined, 'once')
  })

  test('shows shell commands in the regular tool approval card', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const agent = useAgentStore()
    const response = vi.spyOn(agent, 'respondHITL').mockResolvedValue()
    agent.handleHITLRequest({ taskId: 'shell-review', toolCalls: [{ name: 'shell_execute', arguments: JSON.stringify({ command: 'cat report.txt', cwd: '/projects/private' }) }] })
    const wrapper = mount(HITLDialog, { global: { plugins: [pinia], stubs: { Icon: true } } })
    expect(wrapper.text()).toContain('cat report.txt')
    expect(wrapper.text()).toContain('/projects/private')
    expect(wrapper.text()).toContain('shell_execute')
    await wrapper.findAll('button').find(button => button.text() === 'Allow')!.trigger('click')
    expect(response).toHaveBeenCalledWith(true, undefined, 'once')
  })

  test('offers session and saved approvals for shell commands', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const agent = useAgentStore()
    const response = vi.spyOn(agent, 'respondHITL').mockResolvedValue()
    agent.handleHITLRequest({ taskId: 'shell-options', toolCalls: [{ name: 'shell_execute', arguments: JSON.stringify({ command: 'echo hello' }) }] })
    const wrapper = mount(HITLDialog, { global: { plugins: [pinia], stubs: { Icon: true } } })
    await wrapper.findAll('button').find(button => button.findComponent({ name: 'Icon' }).exists())!.trigger('click')
    expect(wrapper.text()).toContain('Allow in this Session')
    expect(wrapper.text()).toContain('Allow All (shell_execute)')
    await wrapper.findAll('button').find(button => button.text() === 'Allow in this Session')!.trigger('click')
    expect(response).toHaveBeenCalledWith(true, undefined, 'session')
  })
})
