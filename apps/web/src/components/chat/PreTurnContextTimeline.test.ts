import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import PreTurnContextTimeline from './PreTurnContextTimeline.vue'

const global = { stubs: { Icon: true } }

describe('PreTurnContextTimeline', () => {
  test('renders memory and tool gathering as separate cards with independent headings', () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [
          { iteration: 0, taskId: 'memory', status: 'searching-memory', message: 'Searching memory with hybrid RAG...', timestamp: 100 },
          { iteration: 0, taskId: 'tools', status: 'finding-tools', message: 'Ranking selected tools...', timestamp: 200 },
        ],
        isActive: true,
      },
      global,
    })

    const cards = wrapper.findAll('.pre-turn-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('Auto memory')
    expect(cards[0].get('[role="status"]').text()).toBe('Searching memory with hybrid RAG...')
    expect(cards[1].text()).toContain('Auto tools')
    expect(cards[1].get('[role="status"]').text()).toBe('Ranking selected tools...')
    expect(wrapper.findAll('icon-stub[icon="svg-spinners:ring-resize"]')).toHaveLength(2)
  })

  test('shows the full memory pipeline and final memories as a score-sorted card grid', async () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [
          { iteration: 0, taskId: 'memory', status: 'searching-memory', timestamp: 100 },
          { iteration: 0, taskId: 'memory', status: 'reranking-memory', timestamp: 110 },
          { iteration: 0, taskId: 'memory', status: 'filtering-memory', timestamp: 120 },
          { iteration: 0, taskId: 'memory', status: 'selecting-memory', timestamp: 130 },
          {
            iteration: 0, taskId: 'memory', status: 'selecting-memory', timestamp: 140,
            toolCalls: [
              { name: 'lower', arguments: JSON.stringify({ type: 'memory', contextPhase: 'gathered-context', selectionMethod: 'reranker', sourceFile: 'lower.md', matchScore: .62, content: 'A lower-scoring excerpt.' }) },
              { name: 'best', arguments: JSON.stringify({ type: 'memory', contextPhase: 'gathered-context', selectionMethod: 'reranker', sourceFile: 'best.md', matchScore: .94, content: 'The strongest matching memory excerpt.' }) },
            ],
          },
        ],
        isActive: false,
      },
      global,
    })

    expect(wrapper.get('[role="status"]').text()).toBe('Selected 2 reranked memories')
    const collapsedResults = wrapper.get('[aria-label="Auto memory selected results"]')
    expect(collapsedResults.text()).toContain('best.md94%')
    expect(collapsedResults.text()).toContain('lower.md62%')
    await wrapper.get('.pre-turn-card > button').trigger('click')
    const text = wrapper.text()
    expect(text).toContain('Searching memory with RAG')
    expect(text).toContain('Reranking memory matches')
    expect(text).toContain('Filtering memory matches')
    expect(text).toContain('Selecting reranked memories')
    const cards = wrapper.findAll('.memory-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('best.md')
    expect(cards[0].text()).toContain('94%')
    expect(cards[0].text()).toContain('strongest matching memory excerpt')
    expect(cards[1].text()).toContain('lower.md')
  })

  test('shows only MCPs when collapsed and their individual tools when expanded', async () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [
          {
            iteration: 0, taskId: 'tools', status: 'routing-tools', timestamp: 100,
            toolCalls: [
              { name: 'GitHub MCP', arguments: JSON.stringify({ type: 'toolset-router', namespaceId: 'mcp:github', selectionMethod: 'llm' }) },
              { name: 'Documents', arguments: JSON.stringify({ type: 'toolset-router', namespaceId: 'toolset:documents', selectionMethod: 'llm' }) },
            ],
          },
          {
            iteration: 0, taskId: 'tools', status: 'finding-tools', timestamp: 120,
            toolCalls: [
              { name: 'search_repositories', arguments: JSON.stringify({ type: 'tool-router', contextPhase: 'gathered-context', selectionMethod: 'semantic', namespaceId: 'mcp:github', namespaceLabel: 'GitHub MCP', routerScore: .88 }) },
              { name: 'read_document', arguments: JSON.stringify({ type: 'tool-router', contextPhase: 'gathered-context', selectionMethod: 'automatic', namespaceId: 'toolset:documents', namespaceLabel: 'Documents' }) },
            ],
          },
        ],
        isActive: false,
      },
      global,
    })

    const collapsedResults = wrapper.get('[aria-label="Auto tools selected results"]')
    expect(collapsedResults.text()).toContain('GitHub MCP')
    expect(collapsedResults.text()).toContain('Documents')
    expect(collapsedResults.text()).not.toContain('search_repositories')
    expect(collapsedResults.text()).not.toContain('read_document')
    expect(wrapper.get('.count-chip').text()).toBe('2 MCPs/toolsets')
    await wrapper.get('.pre-turn-card > button').trigger('click')
    const toolsets = wrapper.findAll('.toolset-card')
    expect(toolsets).toHaveLength(2)
    expect(toolsets[0].text()).toContain('GitHub MCP')
    expect(toolsets[0].text()).toContain('search_repositories')
    expect(toolsets[0].text()).toContain('88%')
    expect(toolsets[1].text()).toContain('Documents')
    expect(toolsets[1].text()).toContain('read_document')
  })

  test('does not render shared query planning as a third context card', () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [{
          iteration: 0,
          status: 'building-task-context',
          timestamp: 100,
          toolCalls: [{ name: 'Task context', arguments: JSON.stringify({ type: 'task-context', toolQuery: 'tools', memoryQuery: 'memory' }) }],
        }],
        isActive: true,
      },
      global,
    })
    expect(wrapper.findAll('.pre-turn-card')).toHaveLength(0)
  })

  test('keeps empty selections visible without counting them', async () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [{
          iteration: 0, taskId: 'memory', status: 'curating-memory', timestamp: 100,
          toolCalls: [{ name: 'No relevant memories', arguments: JSON.stringify({ type: 'memory', contextPhase: 'gathered-context', selectionMethod: 'llm', emptyReason: 'none-relevant' }) }],
        }],
        isActive: false,
      },
      global,
    })
    expect(wrapper.get('[role="status"]').text()).toBe('No memories selected')
    expect(wrapper.find('.count-chip').exists()).toBe(false)
    await wrapper.get('.pre-turn-card > button').trigger('click')
    expect(wrapper.findAll('.memory-card')).toHaveLength(0)
  })
})
