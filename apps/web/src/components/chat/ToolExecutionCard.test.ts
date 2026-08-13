import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'
import ToolExecutionCard from './ToolExecutionCard.vue'

describe('ToolExecutionCard', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  test('summarizes gathered memory with unique file names and omits space names', () => {
    const memoryArguments = (chunkIndex: number) => JSON.stringify({
      type: 'memory',
      contextPhase: 'gathered-context',
      sourceFile: 'Communication Personality Analysis.md',
      folderPath: 'Default',
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
    expect(summary).toContain('Gathered Memory Context')
    expect(summary).toContain('Communication Personality Analysis.md')
    expect(summary).not.toContain('Default')
    expect(summary.match(/Communication Personality Analysis\.md/g)).toHaveLength(1)
  })

  test('surfaces entity graph evidence included in gathered memory context', async () => {
    const graphContext = [
      '## Entity Graph Context',
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
            name: 'Entity Graph Context',
            arguments: JSON.stringify({
              type: 'memory',
              memoryKind: 'entity-graph',
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

    expect(wrapper.get('button').text()).toContain('Entity Graph Context')
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain(graphContext)
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
})
