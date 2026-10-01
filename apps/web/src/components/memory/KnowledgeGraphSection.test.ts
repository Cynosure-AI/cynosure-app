import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'
import KnowledgeGraphSection from './KnowledgeGraphSection.vue'

vi.mock('@vue-flow/core', () => ({
  BaseEdge: { template: '<div />' },
  EdgeLabelRenderer: { template: '<div />' },
  Handle: { template: '<div />' },
  VueFlow: { template: '<div />' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  getBezierPath: vi.fn(), getSmoothStepPath: vi.fn(), getStraightPath: vi.fn(),
  useVueFlow: () => ({ fitView: vi.fn(), getSelectedNodes: ref([]), removeSelectedElements: vi.fn() }),
}))
vi.mock('@vue-flow/controls', () => ({ Controls: { template: '<div />' } }))

test('housekeeping is available even with an empty graph and prevents another launch while pending', async () => {
  const wrapper = mount(KnowledgeGraphSection, {
    props: {
      flowId: 'test', graph: null, graphLoading: false,
      graphQuery: '', graphSearchQuery: '', graphSuggestions: [], walkNodes: [],
      graphFlowNodes: [], graphFlowEdges: [], nodeSpacing: 1,
      edgeLabelsVisible: true, edgePathType: 'bezier', factLevel: 0, entityLimit: 100,
    },
    global: { stubs: { Icon: true, KnowledgeGraphSearchBox: true, KnowledgeGraphInspector: true } },
  })
  const button = wrapper.get('button[title*="one-off cron chat"]')
  expect(button.text()).toBe('Run housekeeping')
  await button.trigger('click')
  expect(wrapper.emitted('start-housekeeping')).toHaveLength(1)

  await wrapper.setProps({ housekeepingPending: true })
  expect(button.attributes('disabled')).toBeDefined()
  expect(button.text()).toBe('Starting housekeeping...')
  await button.trigger('click')
  expect(wrapper.emitted('start-housekeeping')).toHaveLength(1)
  wrapper.unmount()
})
