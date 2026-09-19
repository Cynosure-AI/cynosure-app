import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { h, nextTick } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../../api/client'
import type { MemoryFolder } from '../../../api/types'
import { useChatStore } from '../../../stores/chat.store'
import MemoryFolderSelectorPopover from './MemoryFolderSelectorPopover.vue'

const memoryFolders = [
  folder('root', 'All Memory', '', null, true),
  folder('projects', 'Projects', 'Projects'),
  folder('alpha', 'Alpha', 'Projects/Alpha', 'Projects'),
  folder('personal', 'Personal', 'Personal'),
  folder('archive', 'Archive', 'Archive'),
]

describe('MemoryFolderSelectorPopover', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    setActivePinia(createPinia())
    vi.spyOn(api.memoryFolders, 'list').mockResolvedValue(memoryFolders)
  })

  test('drills through nested folders and returns to the parent list', async () => {
    const wrapper = mountPopover()

    await wrapper.get('[data-test="trigger"]').trigger('click')
    await flushPromises()

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('Projects')
    expect(document.body.textContent).not.toContain('Alpha')

    document.body.querySelector<HTMLButtonElement>('[aria-label="Open Projects"]')?.click()
    await nextTick()

    expect(document.body.querySelector('[aria-label="Back to parent memory folder"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).not.toContain('Personal')

    document.body.querySelector<HTMLButtonElement>('[aria-label="Back to parent memory folder"]')?.click()
    await nextTick()
    expect(document.body.textContent).toContain('Personal')

    wrapper.unmount()
  })

  test('supports leaf and whole-folder selection in the popover', async () => {
    const wrapper = mountPopover()
    const chatStore = useChatStore()

    await wrapper.get('[data-test="trigger"]').trigger('click')
    await flushPromises()

    document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Projects"]')?.click()
    await nextTick()
    expect(chatStore.freeChatMemoryFolderIds).toEqual(['personal'])
    expect(document.body.querySelector('[aria-label="Toggle All Memory"]')?.getAttribute('aria-checked')).toBe('mixed')

    document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Projects"]')?.click()
    await nextTick()
    expect(chatStore.freeChatMemoryFolderIds).toEqual(['personal', 'projects', 'alpha'])

    document.body.querySelector<HTMLButtonElement>('[aria-label="Open Projects"]')?.click()
    await nextTick()
    menuItem('Alpha').click()
    await nextTick()
    expect(chatStore.freeChatMemoryFolderIds).toEqual(['personal', 'projects'])
    expect(chatStore.freeChatMemorySelectionInitialized).toBe(true)

    wrapper.unmount()
  })

  test('keeps All Memory selected when toggling an opt-in folder', async () => {
    const wrapper = mountPopover()
    const chatStore = useChatStore()

    await wrapper.get('[data-test="trigger"]').trigger('click')
    await flushPromises()
    expect(chatStore.freeChatMemoryFolderIds).toEqual(['root'])

    document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Archive"]')?.click()
    await nextTick()
    expect(chatStore.freeChatMemoryFolderIds).toEqual(['root', 'archive'])

    document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Archive"]')?.click()
    await nextTick()
    expect(chatStore.freeChatMemoryFolderIds).toEqual(['root'])

    wrapper.unmount()
  })
})

function mountPopover() {
  return mount(MemoryFolderSelectorPopover, {
    attachTo: document.body,
    slots: {
      trigger: ({ toggle }: { toggle: () => void }) => h('button', { 'data-test': 'trigger', onClick: toggle }, 'Memory'),
    },
    global: { stubs: { Icon: true, ToggleSwitch: true } },
  })
}

function menuItem(label: string): HTMLElement {
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((candidate) => candidate.textContent?.includes(label))
  if (!item) throw new Error(`Missing menu item: ${label}`)
  return item
}

function folder(
  id: string,
  name: string,
  folderPath: string,
  parentFolderPath: string | null = null,
  isUncategorized = false,
): MemoryFolder {
  return {
    id,
    name,
    description: '',
    directoryPath: `/memory/${folderPath}`,
    folderPath,
    parentFolderPath,
    sortOrder: 0,
    isUncategorized,
    createdAt: 0,
    fileCount: 1,
  }
}
