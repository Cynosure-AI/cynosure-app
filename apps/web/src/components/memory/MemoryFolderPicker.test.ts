import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import type { MemoryFolder } from '../../api/types'
import MemoryFolderPicker from './MemoryFolderPicker.vue'

function folder(id: string, folderPath: string, isUncategorized = false, autoMemoryExcluded = false): MemoryFolder {
  return {
    id,
    name: id,
    description: '',
    directoryPath: `/memory/${folderPath}`,
    folderPath,
    sortOrder: 0,
    isUncategorized,
    autoMemoryExcluded,
    createdAt: 1,
    fileCount: 2,
  }
}

const folders = [
  folder('projects-a', 'Projects/A'),
  folder('root', '', true),
  folder('projects', 'Projects'),
  folder('archive', 'Archive', false, true),
]

function row(wrapper: ReturnType<typeof mount>, id: string) {
  return wrapper.get(`[data-folder-id="${id}"]`)
}

describe('MemoryFolderPicker', () => {
  test('shows subfolders of a granted folder as inherited and locked', () => {
    const wrapper = mount(MemoryFolderPicker, { props: { folders, modelValue: ['projects'], search: 'a' } })
    const child = row(wrapper, 'projects-a')
    const checkbox = child.get('input[type="checkbox"]').element as HTMLInputElement

    expect(child.attributes('data-state')).toBe('inherited')
    expect(checkbox.checked).toBe(true)
    expect(checkbox.disabled).toBe(true)
    expect(child.text()).toContain('Included via projects')
  })

  test('marks a parent with granted subfolders as indeterminate', () => {
    const wrapper = mount(MemoryFolderPicker, { props: { folders, modelValue: ['projects-a'] } })
    const checkbox = row(wrapper, 'projects').get('input[type="checkbox"]').element as HTMLInputElement

    expect(checkbox.checked).toBe(false)
    expect(checkbox.indeterminate).toBe(true)
  })

  test('labels opt-in folders and describes All Memory with them', () => {
    const wrapper = mount(MemoryFolderPicker, { props: { folders, modelValue: ['root'] } })

    expect(row(wrapper, 'archive').text()).toContain('Opt-in')
    expect(row(wrapper, 'archive').attributes('data-state')).toBe('none')
    expect(row(wrapper, 'root').text()).toContain('Every folder except 1 opt-in folder')
  })

  test('checking a parent replaces the subfolder grants it covers', async () => {
    const wrapper = mount(MemoryFolderPicker, { props: { folders, modelValue: ['projects-a'] } })
    await row(wrapper, 'projects').get('input[type="checkbox"]').trigger('change')

    expect(wrapper.emitted('update:modelValue')).toEqual([[['projects']]])
  })

  test('search shows matches with their path', () => {
    const wrapper = mount(MemoryFolderPicker, { props: { folders, modelValue: [], search: 'projects/a' } })

    expect(wrapper.findAll('[data-folder-id]')).toHaveLength(1)
    expect(row(wrapper, 'projects-a').text()).toContain('Projects/A')
  })
})
