import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../../api/client'
import FolderPickerDialog from './FolderPickerDialog.vue'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

test('navigates into subfolders and selects the current folder', async () => {
  const directories = vi.spyOn(api.fileAccess, 'directories').mockImplementation(async (path?: string) => (
    path === '/home/user/code'
      ? { path: '/home/user/code', parent: '/home/user', home: '/home/user', directories: [] }
      : { path: '/home/user', parent: '/home', home: '/home/user', directories: [{ name: 'code', path: '/home/user/code' }] }
  ))
  const wrapper = mount(FolderPickerDialog, {
    attachTo: document.body,
    props: { show: true },
    global: { stubs: { Icon: true } },
  })
  await flushPromises()
  expect(directories).toHaveBeenCalledWith(undefined, false)

  const folderButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('code'))
  folderButton?.click()
  await flushPromises()
  expect(directories).toHaveBeenLastCalledWith('/home/user/code', false)

  const selectButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('Select this folder'))
  selectButton?.click()
  expect(wrapper.emitted('select')).toEqual([['/home/user/code']])
  expect(wrapper.emitted('close')).toHaveLength(1)
  wrapper.unmount()
})

test('falls back to the home folder when the initial path is invalid', async () => {
  const directories = vi.spyOn(api.fileAccess, 'directories').mockImplementation(async (path?: string) => {
    if (path) throw new Error('That folder does not exist.')
    return { path: '/home/user', parent: '/home', home: '/home/user', directories: [] }
  })
  const wrapper = mount(FolderPickerDialog, {
    attachTo: document.body,
    props: { show: true, initialPath: '/missing' },
    global: { stubs: { Icon: true } },
  })
  await flushPromises()
  expect(directories).toHaveBeenNthCalledWith(1, '/missing', false)
  expect(directories).toHaveBeenNthCalledWith(2, undefined, false)
  expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Current folder"]')?.value).toBe('/home/user')
  wrapper.unmount()
})
