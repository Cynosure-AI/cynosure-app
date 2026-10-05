import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, expect, test, vi } from 'vitest'
import SettingsView from './SettingsView.vue'
import MemorySettings from '../../components/settings/MemorySettings.vue'

const route = vi.hoisted(() => ({ query: {} as Record<string, string> }))

vi.mock('vue-router', () => ({
  onBeforeRouteLeave: vi.fn(),
  useRoute: () => route,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const ResponsiveSectionLayout = {
  props: ['detailOpen'],
  template: '<div :data-detail-open="String(detailOpen)"><slot name="sidebar" /><slot /></div>',
}

function mountSettings() {
  return shallowMount(SettingsView, { global: { stubs: { Teleport: true, ResponsiveSectionLayout } } })
}

afterEach(() => {
  route.query = {}
})

test('settings search discovers the experimental Dream section in Memory', async () => {
  route.query = { category: 'memory', search: 'dream' }
  const wrapper = mountSettings()
  await flushPromises()
  expect(wrapper.getComponent(MemorySettings).props('visibleSections')).toContain('dream-mode')
  wrapper.unmount()
})

test('a link to a category opens that category from the top of the content pane', async () => {
  route.query = { category: 'backup' }
  const scrollTo = vi.fn()
  HTMLElement.prototype.scrollTo = scrollTo
  const scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollIntoView = scrollIntoView

  const wrapper = mountSettings()
  await flushPromises()

  expect(wrapper.find('[data-detail-open]').attributes('data-detail-open')).toBe('true')
  expect(wrapper.find('#settings-backup').exists()).toBe(true)
  // Scrolling the section into view would hide its heading under the sticky search bar.
  expect(scrollIntoView).not.toHaveBeenCalled()
  expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
  wrapper.unmount()
})

test('opening settings without a category starts at the category list on narrow screens', async () => {
  const wrapper = mountSettings()
  await flushPromises()

  expect(wrapper.find('[data-detail-open]').attributes('data-detail-open')).toBe('false')
  wrapper.unmount()
})
