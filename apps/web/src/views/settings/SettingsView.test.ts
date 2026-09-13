import { flushPromises, shallowMount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
import SettingsView from './SettingsView.vue'
import MemorySettings from '../../components/settings/MemorySettings.vue'

vi.mock('vue-router', () => ({
  onBeforeRouteLeave: vi.fn(),
  useRoute: () => ({ query: { category: 'memory', search: 'dream' } }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
test('settings search discovers the experimental Dream section in Memory', async () => {
  const wrapper = shallowMount(SettingsView, { global: { stubs: {
    Teleport: true,
    ResponsiveSectionLayout: { template: '<div><slot name="sidebar" /><slot /></div>' },
  } } })
  await flushPromises()
  expect(wrapper.getComponent(MemorySettings).props('visibleSections')).toEqual(['dream-mode'])
  wrapper.unmount()
})
