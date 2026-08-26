import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import PreTurnContextTimeline from './PreTurnContextTimeline.vue'

describe('PreTurnContextTimeline', () => {
  const steps = [
    {
      iteration: 0,
      status: 'building-task-context',
      timestamp: 1_700_000_000_000,
      toolCalls: [{
        name: 'Task context',
        arguments: JSON.stringify({ type: 'task-context', toolQuery: 'read a document', memoryQuery: 'project preferences' }),
      }],
    },
    {
      iteration: 0,
      status: 'routing-tools',
      message: 'Selecting required MCPs and toolsets...',
      timestamp: 1_700_000_000_100,
      toolCalls: [
        { name: 'Filesystem', arguments: JSON.stringify({ type: 'toolset-router', namespaceId: 'mcp:filesystem' }) },
        { name: 'Documents', arguments: JSON.stringify({ type: 'toolset-router', namespaceId: 'toolset:documents' }) },
      ],
    },
    {
      iteration: 0,
      status: 'routing-tools',
      timestamp: 1_700_000_000_200,
      toolCalls: [
        { name: 'read_file', arguments: JSON.stringify({ type: 'tool-router', contextPhase: 'gathered-results', routerScore: .92 }) },
        { name: 'parse_document', arguments: JSON.stringify({ type: 'tool-router', contextPhase: 'gathered-results', routerScore: .81 }) },
      ],
    },
    {
      iteration: 0,
      status: 'curating-tools',
      timestamp: 1_700_000_000_300,
      toolCalls: [{ name: 'read_file', arguments: JSON.stringify({ type: 'tool-router', contextPhase: 'gathered-context', routerScore: .92 }) }],
    },
  ]

  test('renders pre-turn work as a collapsed historical summary', () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: { steps, isActive: false },
      global: { stubs: { Icon: true } },
    })

    expect(wrapper.get('button').text()).toContain('Pre-turn context')
    expect(wrapper.get('button').text()).toContain('1 tool')
    expect(wrapper.get('button').text()).toContain('2 toolsets')
    expect(wrapper.get('button').text()).toContain('4 steps')
    expect(wrapper.text()).not.toContain('Found 2 tool candidates')
  })

  test('expands the timeline and then an individual step detail', async () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: { steps, isActive: false },
      global: { stubs: { Icon: true } },
    })

    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('AI wrote retrieval queries')
    expect(wrapper.text()).toContain('LLM-generated routing intent')
    expect(wrapper.text()).toContain('AI selected 2 MCPs/toolsets')
    expect(wrapper.text()).toContain('Semantic search found 2 tool candidates')
    expect(wrapper.text()).toContain('Semantic search matched 1 tool')

    const preselectionStep = wrapper.findAll('li').find((item) => item.text().includes('AI selected 2 MCPs/toolsets'))!
    expect(preselectionStep.text()).not.toContain('Filesystem')
    await preselectionStep.get('button').trigger('click')
    expect(preselectionStep.text()).toContain('Filesystem')
    expect(preselectionStep.text()).toContain('Documents')

    const foundStep = wrapper.findAll('li').find((item) => item.text().includes('Semantic search found 2 tool candidates'))!
    expect(foundStep.text()).not.toContain('read_file')
    await foundStep.get('button').trigger('click')
    expect(foundStep.text()).toContain('read_file')
    expect(foundStep.text()).toContain('92%')
    expect(foundStep.text()).toContain('parse_document')
  })

  test('does not count an empty memory result as a selected memory item', async () => {
    const memorySteps = [
      {
        iteration: 0,
        status: 'routing-memory',
        timestamp: 1_700_000_000_400,
        toolCalls: Array.from({ length: 9 }, (_, index) => ({
          name: `memory-${index + 1}.md`,
          arguments: JSON.stringify({ type: 'memory', contextPhase: 'gathered-results', selectionMethod: 'retrieval', matchScore: .9 - index / 20 }),
        })),
      },
      {
        iteration: 0,
        status: 'curating-memory',
        timestamp: 1_700_000_000_500,
        toolCalls: [{
          name: 'No relevant memories',
          arguments: JSON.stringify({
            type: 'memory',
            contextPhase: 'gathered-context',
            selectionMethod: 'llm',
            emptyReason: 'none-relevant',
            content: 'Auto memory found candidates, but the curation step selected none as useful for this turn.',
          }),
        }],
      },
    ]
    const wrapper = mount(PreTurnContextTimeline, {
      props: { steps: memorySteps, isActive: false },
      global: { stubs: { Icon: true } },
    })

    expect(wrapper.get('button').text()).not.toContain('memory item')
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('Memory retrieval found 9 matches')
    expect(wrapper.text()).toContain('AI selected no memory items')
    expect(wrapper.text()).toContain('LLM decision')

    const selectionStep = wrapper.findAll('li').find((item) => item.text().includes('AI selected no memory items'))!
    await selectionStep.get('button').trigger('click')
    expect(selectionStep.text()).toContain('No relevant memories')
  })
})
