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
})
