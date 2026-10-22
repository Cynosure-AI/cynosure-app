import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'
import SubAgentDelegationCard from './SubAgentDelegationCard.vue'
import type { DelegationEntry, SubAgentRun } from '../../utils/delegation-timeline'
import type { DisplayMessage } from '../../stores/chat.store'

const message = (id: string, ts: number, extra: Partial<DisplayMessage> = {}) => ({
  type: 'message' as const,
  key: `m-${id}`,
  ts,
  isSubAgent: true,
  msg: { id, createdAt: ts, role: 'assistant' as const, content: id, ...extra },
})

const run = (key: string, extra: Partial<SubAgentRun> = {}): SubAgentRun => ({
  key,
  invocationId: key,
  codename: key,
  agentName: null,
  agentId: null,
  openingMessage: `Task for ${key}`,
  continued: false,
  entries: [],
  ...extra,
})

const delegation = (runs: SubAgentRun[]): DelegationEntry => ({ type: 'delegation', key: 'dl', ts: 0, call: null, runs })

function mountCard(entry: DelegationEntry, props: { isExecuting?: boolean; liveRunKey?: string | null; expanded?: string[] } = {}) {
  return mount(SubAgentDelegationCard, {
    props: {
      delegation: entry,
      isExecuting: props.isExecuting ?? false,
      liveRunKey: props.liveRunKey ?? null,
      isCallActive: false,
      isRunExpanded: (key: string) => (props.expanded ?? []).includes(key),
    },
    slots: { run: '<div class="transcript">transcript of {{ params.run.key }}</div>' },
    global: { stubs: { Icon: true } },
  })
}

describe('SubAgentDelegationCard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('shows sequential runs as finished, working and queued around the live one', () => {
    const wrapper = mountCard(delegation([
      run('alpha', { entries: [message('Found three candidates', 1)] }),
      run('beta', { entries: [message('', 2, { isStreaming: true, thinking: 'Hmm' })] }),
      run('gamma'),
    ]), { isExecuting: true, liveRunKey: 'beta' })

    const rows = wrapper.findAll('[role="button"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('Finished')
    expect(rows[0].text()).toContain('Found three candidates')
    expect(rows[1].text()).toContain('Working')
    expect(rows[1].text()).toContain('Thinking…')
    expect(rows[2].text()).toContain('Queued')
    expect(wrapper.text()).toContain('Delegated to 3 sub-agents')
    expect(wrapper.text()).toContain('1/3 done')
  })

  test('summarizes returned and failed results and marks continued sessions', () => {
    const wrapper = mountCard(delegation([
      run('alpha', { continued: true, result: { name: 'continue_subagent', success: true, output: 'Sub-agent invocation ID: alpha\n\n**Booked** the slot' } }),
      run('beta', { result: { name: 'spawn_subagent', success: false, output: '', error: 'No sub-agent session "beta" exists.' } }),
    ]))

    const rows = wrapper.findAll('[role="button"]')
    expect(rows[0].text()).toContain('Continued')
    expect(rows[0].text()).toContain('Booked the slot')
    expect(rows[0].text()).toContain('Returned')
    expect(rows[1].text()).toContain('No sub-agent session "beta" exists.')
    expect(rows[1].text()).toContain('Failed')
  })

  test('removes the working indicator when an unfinished delegation ends', async () => {
    const wrapper = mountCard(delegation([
      run('interrupted', { entries: [message('Searching', 1)] }),
    ]), { isExecuting: true, liveRunKey: 'interrupted' })
    expect(wrapper.text()).toContain('Working')
    expect(wrapper.find('.run-avatar--live').exists()).toBe(true)

    await wrapper.setProps({ isExecuting: false, liveRunKey: null })
    expect(wrapper.text()).toContain('Ended')
    expect(wrapper.text()).not.toContain('Working')
    expect(wrapper.find('.run-avatar--live').exists()).toBe(false)
    wrapper.unmount()
  })

  test('renders a single run as the card itself and its transcript when expanded', async () => {
    const wrapper = mountCard(delegation([run('solo', { entries: [message('Done', 1)] })]), { expanded: ['solo'] })

    expect(wrapper.text()).not.toContain('Delegated to')
    expect(wrapper.get('.transcript').text()).toBe('transcript of solo')
    await wrapper.get('[role="button"]').trigger('click')
    expect(wrapper.emitted('toggleRun')).toEqual([['solo']])
  })
})
