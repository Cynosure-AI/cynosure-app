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
              { name: 'lower', arguments: JSON.stringify({ type: 'memory', contextPhase: 'gathered-context', selectionMethod: 'reranker', sourceFile: 'lower.md', matchScore: .62, content: 'A lower-scoring excerpt.', pipelineStats: { queryCount: 2, searchCandidateCount: 40, rerankerInputCount: 40, rerankerOutputCount: 16, returnedCount: 16, uniqueCount: 12, filteredCount: 7, duplicateCount: 4, weakCount: 5, relativeScoreThreshold: .65 } }) },
              { name: 'best', arguments: JSON.stringify({ type: 'memory', contextPhase: 'gathered-context', selectionMethod: 'reranker', sourceFile: 'best.md', matchScore: .94, content: 'The strongest matching memory excerpt.', pipelineStats: { queryCount: 2, searchCandidateCount: 40, rerankerInputCount: 40, rerankerOutputCount: 16, returnedCount: 16, uniqueCount: 12, filteredCount: 7, duplicateCount: 4, weakCount: 5, relativeScoreThreshold: .65 } }) },
            ],
          },
        ],
        isActive: false,
      },
      global,
    })

    expect(wrapper.get('[role="status"]').text()).toBe('Selected top 2 memories')
    expect(wrapper.get('.count-chip').text()).toBe('2 memories')
    const collapsedResults = wrapper.get('[aria-label="Auto memory selected results"]')
    expect(collapsedResults.text()).toContain('best.md94%')
    expect(collapsedResults.text()).toContain('lower.md62%')
    await wrapper.get('.pre-turn-card > button').trigger('click')
    const text = wrapper.text()
    expect(text).toContain('Hybrid search found 40 candidates')
    expect(text).toContain('Reranked 40 candidates down to 16 matches')
    expect(text).toContain('Fused 16 matches into 12 unique matches, kept 7')
    expect(text).toContain('4 matches appeared in multiple queries and were deduplicated; 5 more results dropped for scoring below 65% of the strongest match')
    expect(text).toContain('Selected top 2 memories')
    expect(text).not.toContain('Found 2 memory matches')
    expect(text).not.toContain('Selecting the highest-ranked memories')
    expect(wrapper.findAll('ol > li').map((item) => item.text())).toEqual([
      expect.stringContaining('Hybrid search found 40 candidates'),
      expect.stringContaining('Reranked 40 candidates down to 16 matches'),
      expect.stringContaining('Fused 16 matches into 12 unique matches, kept 7'),
      expect.stringContaining('Selected top 2 memories'),
    ])
    const cards = wrapper.findAll('.memory-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('best.md')
    expect(cards[0].text()).toContain('94%')
    expect(cards[0].text()).toContain('strongest matching memory excerpt')
    expect(cards[1].text()).toContain('lower.md')
  })

  test('shows the full selected memory content in a hover tooltip', async () => {
    const fullContent = 'First line of the memory.\nSecond line that remains available beyond the card preview.'
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [{
          iteration: 0, taskId: 'memory', status: 'selecting-memory', timestamp: 100,
          toolCalls: [{
            name: 'memory', arguments: JSON.stringify({
              type: 'memory', contextPhase: 'gathered-context', selectionMethod: 'reranker',
              sourceFile: 'complete-memory.md', content: fullContent,
            })
          }],
        }],
        isActive: false,
      },
      global,
    })

    await wrapper.get('.pre-turn-card > button').trigger('click')
    await wrapper.get('.memory-grid > div').trigger('mouseenter', { clientX: 100, clientY: 100 })

    const tooltip = document.body.querySelector('[aria-label="Full memory content for complete-memory.md"]')
    expect(tooltip?.textContent).toContain(fullContent)
  })

  test('expands pre-reranker search matches but keeps the final selection row collapsed', async () => {
    const pipelineStats = {
      queryCount: 1, searchCandidateCount: 3, rerankerInputCount: 3, rerankerOutputCount: 2,
      returnedCount: 2, uniqueCount: 2, filteredCount: 2, duplicateCount: 0, weakCount: 0,
      relativeScoreThreshold: .65,
      searchMatches: [
        { name: 'second.md', content: 'Second candidate', matchScore: .61 },
        { name: 'best.md', content: 'Best candidate', matchScore: .93 },
        { name: 'third.md', content: 'Third candidate', matchScore: .42 },
      ],
    }
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [
          { iteration: 0, taskId: 'memory', status: 'searching-memory', timestamp: 100 },
          {
            iteration: 0, taskId: 'memory', status: 'selecting-memory', timestamp: 120,
            toolCalls: [{
              name: 'best.md', arguments: JSON.stringify({
                type: 'memory', contextPhase: 'gathered-context', selectionMethod: 'reranker',
                sourceFile: 'best.md', matchScore: .93, pipelineStats,
              })
            }],
          },
        ],
        isActive: false,
      },
      global,
    })

    await wrapper.get('.pre-turn-card > button').trigger('click')
    const searchStep = wrapper.findAll('ol button').find((button) => button.text().includes('Hybrid search found'))!
    const finalStep = wrapper.findAll('ol button').find((button) => button.text().includes('Selected top'))!
    expect(searchStep.attributes('aria-expanded')).toBe('false')
    expect(finalStep.attributes('aria-expanded')).toBeUndefined()
    await searchStep.trigger('click')
    const expanded = wrapper.get('[aria-label="Auto memory pipeline"]').text()
    expect(expanded.indexOf('best.md')).toBeLessThan(expanded.indexOf('second.md'))
    expect(expanded).toContain('best.md93%')
    expect(expanded).toContain('Best candidate')
    expect(expanded).toContain('third.md42%')
  })

  test('shows only MCPs when collapsed and tools inside the expanded completion step', async () => {
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

    const completionStep = wrapper.findAll('ol button').find((button) => button.text().includes('Tool selection complete'))
    expect(completionStep).toBeDefined()
    await completionStep!.trigger('click')
    const includedTools = wrapper.get('[aria-label="All tools included this round"]')
    expect(includedTools.text()).toContain('search_repositories88%')
    expect(includedTools.text()).toContain('read_document')
  })

  test('shows the latest toolset selection once when routing runs twice', async () => {
    const toolsets = ['TickNotes MCP', 'Built-In: Notifications', 'Built-In: Memory']
    const selection = (timestamp: number) => ({
      iteration: 0, taskId: 'tools', status: 'routing-tools', timestamp,
      toolCalls: toolsets.map((name) => ({
        name,
        arguments: JSON.stringify({ type: 'toolset-router', namespaceId: name, selectionMethod: 'llm' }),
      })),
    })
    const wrapper = mount(PreTurnContextTimeline, {
      props: { steps: [selection(100), selection(200)], isActive: false },
      global,
    })

    expect(wrapper.get('.count-chip').text()).toBe('3 MCPs/toolsets')
    const chips = wrapper.findAll('[aria-label="Auto tools selected results"] .collapsed-result-chip')
    expect(chips.map((chip) => chip.text())).toEqual(toolsets)
    await wrapper.get('.pre-turn-card > button').trigger('click')
    expect(wrapper.findAll('.toolset-card')).toHaveLength(3)
    expect(wrapper.findAll('[aria-label="Auto tools pipeline"] > li').length).toBeGreaterThan(1)
  })

  test('lists all retained tools in the completion step without presenting them as auto-selected toolsets', async () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [
          {
            iteration: 0, taskId: 'tools', status: 'routing-tools', timestamp: 100,
            toolCalls: [
              { name: 'No toolsets selected', arguments: JSON.stringify({ type: 'toolset-router', selectionMethod: 'llm', emptyReason: 'none-relevant' }) },
            ],
          },
          {
            iteration: 0, taskId: 'tools', status: 'finding-tools', timestamp: 120,
            toolCalls: [
              { name: 'memory_replace_range', arguments: JSON.stringify({ type: 'tool-router', contextPhase: 'gathered-context', selectionMethod: 'lexical', namespaceId: 'builtin:memory', namespaceLabel: 'Built-In: Memory' }) },
              { name: 'get_weather_forecast', arguments: JSON.stringify({ type: 'tool-router', contextPhase: 'gathered-context', selectionMethod: 'lexical', namespaceId: 'mcp:weather', namespaceLabel: 'Weather Fetcher' }) },
            ],
          },
        ],
        isActive: false,
      },
      global,
    })

    expect(wrapper.find('[aria-label="Auto tools selected results"]').exists()).toBe(false)
    expect(wrapper.find('.count-chip').exists()).toBe(false)
    await wrapper.get('.pre-turn-card > button').trigger('click')
    expect(wrapper.findAll('.toolset-card')).toHaveLength(0)

    const completionStep = wrapper.findAll('ol button').find((button) => button.text().includes('Tool selection complete'))
    expect(completionStep).toBeDefined()
    await completionStep!.trigger('click')

    expect(wrapper.findAll('.toolset-card')).toHaveLength(0)
    const includedTools = wrapper.get('[aria-label="All tools included this round"]')
    expect(includedTools.text()).toContain('memory_replace_range')
    expect(includedTools.text()).toContain('get_weather_forecast')
  })

  test('shows discovery queries in the first memory and tool step details', async () => {
    const wrapper = mount(PreTurnContextTimeline, {
      props: {
        steps: [
          {
            iteration: 0,
            status: 'building-task-context',
            timestamp: 100,
            toolCalls: [{
              name: 'Task context', arguments: JSON.stringify({
                type: 'task-context', selectionMethod: 'llm', requiresTools: true, requiresMemory: true,
                toolSearchQuery: 'calendar scheduling capabilities',
                memorySearchQueries: ['project deadline notes', 'launch date discussion'],
              })
            }],
          },
          { iteration: 0, taskId: 'memory', status: 'searching-memory', timestamp: 110 },
          { iteration: 0, taskId: 'tools', status: 'finding-tools', timestamp: 120 },
        ],
        isActive: true,
      },
      global,
    })
    expect(wrapper.findAll('.pre-turn-card')).toHaveLength(2)
    expect(wrapper.text()).not.toContain('project deadline notes')
    expect(wrapper.text()).not.toContain('calendar scheduling capabilities')

    const cards = wrapper.findAll('.pre-turn-card')
    await cards[0].get(':scope > button').trigger('click')
    expect(cards[0].text()).toContain('Searching memory')
    expect(cards[0].text()).not.toContain('project deadline notes')
    await cards[0].findAll('ol button')[0].trigger('click')
    expect(cards[0].text()).toContain('project deadline notes')
    expect(cards[0].text()).toContain('launch date discussion')

    await cards[1].get(':scope > button').trigger('click')
    expect(cards[1].text()).toContain('Ranking tools')
    await cards[1].findAll('ol button')[0].trigger('click')
    expect(cards[1].text()).toContain('calendar scheduling capabilities')
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
