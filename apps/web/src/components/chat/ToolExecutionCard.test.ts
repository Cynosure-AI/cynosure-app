import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'
import ToolExecutionCard from './ToolExecutionCard.vue'

describe('ToolExecutionCard', () => {
  test.each([
    ['spawn_subagent', 'Spawn sub-agent'],
    ['continue_subagent', 'Continue sub-agent'],
  ])('labels %s distinctly while retaining its regular parameters', async (name, label) => {
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [{
          iteration: 1,
          status: 'executing',
          timestamp: Date.now(),
          toolCalls: [{ name, arguments: JSON.stringify({ instructions: 'Follow the task', context: 'Relevant context' }) }],
        }],
      },
      global: { stubs: { Icon: true } },
    })

    expect(wrapper.text()).toContain(label)
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('instructions')
    expect(wrapper.text()).toContain('context')
  })
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  test('summarizes gathered memory with unique file names and omits space names', () => {
    const memoryArguments = (chunkIndex: number) => JSON.stringify({
      type: 'memory',
      contextPhase: 'gathered-context',
      sourceFile: 'Communication Personality Analysis.md',
      directoryPath: 'Default',
      chunkIndex,
      content: `Memory chunk ${chunkIndex}`,
    })
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [{
          iteration: 1,
          status: 'curating-memory',
          timestamp: Date.now(),
          toolCalls: [
            { name: 'Default - Communication Personality Analysis.md - part 1/2', arguments: memoryArguments(0) },
            { name: 'Default - Communication Personality Analysis.md - part 2/2', arguments: memoryArguments(1) },
          ],
        }],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    const summary = wrapper.get('button').text()
    expect(summary).toContain('Gathered Context')
    expect(summary).toContain('Memory chunks')
    expect(summary).toContain('Communication Personality Analysis.md')
    expect(summary).not.toContain('Default')
    expect(summary.match(/Communication Personality Analysis\.md/g)).toHaveLength(1)
  })

  test('shows only unique memory titles in the header while gathering context', () => {
    const memoryArguments = (sourceFile: string, chunkIndex: number) => JSON.stringify({
      type: 'memory',
      contextPhase: 'gathered-results',
      sourceFile,
      directoryPath: 'Product Research',
      chunkIndex,
      content: `Memory chunk ${chunkIndex}`,
    })
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 0,
        isActive: true,
        steps: [{
          iteration: 0,
          status: 'routing-memory',
          timestamp: Date.now(),
          toolCalls: [
            { name: 'Product Research - Roadmap.md - part 1/2', arguments: memoryArguments('Roadmap.md', 0) },
            { name: 'Product Research - Roadmap.md - part 2/2', arguments: memoryArguments('Roadmap.md', 1) },
            { name: 'Product Research - Interviews.md - part 1/1', arguments: memoryArguments('Interviews.md', 0) },
          ],
        }],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    const summary = wrapper.get('button').text()
    expect(summary).toContain('Gathering Memory Context')
    expect(summary).toContain('Roadmap.md')
    expect(summary).toContain('Interviews.md')
    expect(summary).not.toContain('Product Research')
    expect(summary.match(/Roadmap\.md/g)).toHaveLength(1)
  })

  test('surfaces knowledge evidence included in gathered memory context', async () => {
    const graphContext = [
      '## Knowledge Context',
      '- [core] Cynosure -> uses -> entity memory. Evidence: Project architecture.',
    ].join('\n')
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [{
          iteration: 1,
          status: 'curating-memory',
          timestamp: Date.now(),
          toolCalls: [{
            name: 'Knowledge Context',
            arguments: JSON.stringify({
              type: 'memory',
              memoryKind: 'knowledge',
              contextPhase: 'gathered-context',
              content: graphContext,
            }),
          }],
        }],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    expect(wrapper.get('button').text()).toContain('Gathered Context')
    expect(wrapper.get('button').text()).toContain('Entity relationships')
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('Entity relationships')
    expect(wrapper.text()).toContain(graphContext)
  })

  test('groups gathered context into tools, memory chunks, and entity relationships', async () => {
    const contextArguments = (type: string, extras: Record<string, unknown> = {}) => JSON.stringify({
      type,
      contextPhase: 'gathered-context',
      ...extras,
    })
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [
          {
            iteration: 1,
            status: 'curating-tools',
            timestamp: Date.now(),
            toolCalls: [{ name: 'web_search', arguments: contextArguments('tool-router') }],
          },
          {
            iteration: 1,
            status: 'curating-memory',
            timestamp: Date.now() + 1,
            toolCalls: [
              { name: 'Default - people.md - part 1/1', arguments: contextArguments('memory', { sourceFile: 'people.md', content: 'People memory' }) },
              { name: 'Knowledge Context', arguments: contextArguments('memory', { memoryKind: 'knowledge', content: 'Caroline -> best friend of -> Andi' }) },
            ],
          },
        ],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    expect(wrapper.get('button').text()).toContain('Gathered Context')
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('Tools')
    expect(wrapper.text()).toContain('Memory chunks')
    expect(wrapper.text()).toContain('Entity relationships')
    expect(wrapper.text().indexOf('Entity relationships')).toBeLessThan(wrapper.text().indexOf('Memory chunks'))
  })

  test('shows rejected entity candidates under the finalized entity relationship channel', async () => {
    const graphArgs = (phase: string) => JSON.stringify({
      type: 'memory', memoryKind: 'knowledge', contextPhase: phase,
      content: 'Unrelated graph relationship',
    })
    const memoryArgs = (phase: string) => JSON.stringify({
      type: 'memory', contextPhase: phase, sourceFile: 'selected.md', content: 'Selected memory',
    })
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [
          {
            iteration: 1, status: 'routing-memory', timestamp: Date.now(),
            toolCalls: [
              { name: 'selected.md', arguments: memoryArgs('gathered-results') },
              { name: 'Knowledge Context', arguments: graphArgs('gathered-results') },
            ],
          },
          {
            iteration: 1, status: 'curating-memory', timestamp: Date.now() + 1,
            toolCalls: [{ name: 'selected.md', arguments: memoryArgs('gathered-context') }],
          },
        ],
      },
      global: { stubs: { Icon: true } },
    })

    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('Entity relationships')
    const rejected = wrapper.findAll('.line-through').find((element) => element.text().includes('Knowledge Context'))
    expect(rejected?.exists()).toBe(true)
  })

  test('shows the memory match score supplied by fused retrieval', async () => {
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [{
          iteration: 1,
          status: 'curating-memory',
          timestamp: Date.now(),
          toolCalls: [{
            name: 'Default - deployment.md - part 1/1',
            arguments: JSON.stringify({
              type: 'memory',
              contextPhase: 'gathered-context',
              sourceFile: 'deployment.md',
              content: 'Deployment memory',
              matchScore: 0.84,
              scoreType: 'fusion',
            }),
          }],
        }],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('84%')
    expect(wrapper.find('[title="Relative retrieval match (combined query ranks)"]').exists()).toBe(true)
  })

  test('uses animated feedback while a pre-turn routing phase is pending', async () => {
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 0,
        isActive: true,
        steps: [{
          iteration: 0,
          status: 'routing-tools',
          message: 'Gathering tool context...',
          timestamp: Date.now(),
        }],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    expect(wrapper.get('button icon-stub').attributes('icon')).toBe('svg-spinners:ring-resize')
    await wrapper.get('button').trigger('click')
    expect(wrapper.findAll('icon-stub').filter((icon) => icon.attributes('icon') === 'svg-spinners:ring-resize')).toHaveLength(2)
  })

  test('previews returned images while collapsed and uses the full gallery while expanded', async () => {
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [{
          iteration: 1,
          status: 'executing',
          timestamp: Date.now(),
          toolCalls: [{ name: 'screenshot_page', arguments: '{"url":"https://example.com"}' }],
          results: [{
            name: 'screenshot_page',
            success: true,
            output: '(2 media items returned)',
            images: ['data:image/png;base64,first', 'data:image/png;base64,second'],
          }],
        }],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    const collapsedPreview = wrapper.get('[aria-label="2 returned images"]')
    expect(collapsedPreview.get('img').attributes('src')).toBe('data:image/png;base64,first')
    expect(collapsedPreview.text()).toBe('+1')
    expect(wrapper.findAll('img')).toHaveLength(1)

    await wrapper.get('button').trigger('click')

    expect(wrapper.find('[aria-label="2 returned images"]').exists()).toBe(false)
    expect(wrapper.findAll('img').map((image) => image.attributes('src'))).toEqual([
      'data:image/png;base64,first',
      'data:image/png;base64,second',
    ])
  })

  test('shows mixed tool outcomes as an amber partial success', () => {
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [{
          iteration: 1,
          status: 'executing',
          timestamp: Date.now(),
          toolCalls: [
            { name: 'create_directory', arguments: '{"path":"one"}' },
            { name: 'create_directory', arguments: '{"path":"two"}' },
            { name: 'create_directory', arguments: '{"path":"three"}' },
          ],
          results: [
            { name: 'create_directory', success: true, output: 'created' },
            { name: 'create_directory', success: true, output: 'created' },
            { name: 'create_directory', success: false, output: '', error: 'already exists' },
          ],
        }],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    const trigger = wrapper.get('button')
    expect(trigger.text()).toContain('2/3 ok · Partial success')
    expect(trigger.get('icon-stub').attributes('icon')).toBe('lucide:triangle-alert')
    expect(trigger.get('icon-stub').classes()).toContain('text-amber-600/80')
  })

  test('reserves the red failed state for rounds where every tool failed', () => {
    const wrapper = mount(ToolExecutionCard, {
      props: {
        iteration: 1,
        isActive: false,
        steps: [{
          iteration: 1,
          status: 'executing',
          timestamp: Date.now(),
          toolCalls: [
            { name: 'create_directory', arguments: '{"path":"one"}' },
            { name: 'create_directory', arguments: '{"path":"two"}' },
          ],
          results: [
            { name: 'create_directory', success: false, output: '', error: 'failed' },
            { name: 'create_directory', success: false, output: '', error: 'failed' },
          ],
        }],
      },
      global: {
        stubs: { Icon: true },
      },
    })

    const trigger = wrapper.get('button')
    expect(trigger.text()).toContain('0/2 ok · Failed')
    expect(trigger.get('icon-stub').attributes('icon')).toBe('lucide:alert-circle')
    expect(trigger.get('icon-stub').classes()).toContain('text-red-500/70')
  })
})
