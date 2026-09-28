import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../../api/client'
import FileAccessSettings from './FileAccessSettings.vue'

afterEach(() => vi.restoreAllMocks())

test('lists, adds, and removes allowed folders', async () => {
  vi.spyOn(api.fileAccess, 'list').mockResolvedValue({ folders: ['/projects'] })
  const add = vi.spyOn(api.fileAccess, 'add').mockResolvedValue({ folders: ['/projects', '/assets'] })
  const remove = vi.spyOn(api.fileAccess, 'remove').mockResolvedValue({ folders: ['/assets'] })
  const wrapper = mount(FileAccessSettings, { global: { stubs: { Icon: true } } })
  await flushPromises()
  expect(wrapper.text()).toContain('/projects')
  await wrapper.get('input[aria-label="Folder path"]').setValue('/assets')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(add).toHaveBeenCalledWith('/assets')
  expect(wrapper.text()).toContain('/assets')
  await wrapper.get('button[aria-label="Remove /projects"]').trigger('click')
  await flushPromises()
  expect(remove).toHaveBeenCalledWith('/projects')
  expect(wrapper.text()).not.toContain('/projects')
})
