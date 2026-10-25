import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import ProjectFolderTab from './ProjectFolderTab.vue'
import { api } from '../../api/client'
import { resetViewLayout } from '../../composables/useViewLayout'
import type { ProjectDto } from '@shared/types'

const project = { id: 'project-1', name: 'Garden Planner', rootPath: '/work/garden' } as ProjectDto

function mountTab() {
  return mount(ProjectFolderTab, {
    props: { project },
    global: {
      stubs: {
        Icon: { props: ['icon'], template: '<i :data-icon="icon" />' },
        DocumentTypeArt: { name: 'DocumentTypeArt', props: ['ext', 'href'], template: '<div class="doc-art" />' },
        RichContent: { props: ['content'], template: '<div class="rich">{{ content }}</div>' },
        ModalDialog: { props: ['show', 'title'], template: '<div v-if="show" class="preview" :data-title="title"><slot /></div>' },
      },
    },
  })
}

function rowButton(wrapper: ReturnType<typeof mountTab>, label: string) {
  return wrapper.findAll('li button').find((button) => button.text().includes(label))!
}

describe('ProjectFolderTab', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
    resetViewLayout()
  })

  test('lists the project folder and opens subfolders', async () => {
    const list = vi.spyOn(api.projects, 'listFiles').mockImplementation(async (_id, opts = {}) => opts.path === 'src'
      ? { path: 'src', entries: [{ name: 'app.ts', path: 'src/app.ts', type: 'file', size: 2048 }] }
      : { path: '', entries: [{ name: 'src', path: 'src', type: 'directory' }, { name: 'README.md', path: 'README.md', type: 'file', size: 12 }] })
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.text()).toContain('/work/garden')
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['srcFolder', 'README.md12 B'])

    await rowButton(wrapper, 'src').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith('project-1', expect.objectContaining({ path: 'src' }))
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['app.ts2.0 KB'])
    expect(wrapper.getComponent({ name: 'DocumentTypeArt' }).props()).toMatchObject({
      ext: 'ts', href: `/api/files?path=${encodeURIComponent('/work/garden/src/app.ts')}`,
    })
    expect(wrapper.get('nav').text()).toContain('src')
  })

  test('shows images as thumbnails and file types as icons in both layouts', async () => {
    vi.spyOn(api.projects, 'listFiles').mockResolvedValue({ path: '', entries: [
      { name: 'logo.png', path: 'assets/logo.png', type: 'file', size: 300 },
      { name: 'plan.pdf', path: 'plan.pdf', type: 'file', size: 300 },
    ] })
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.get('li img').attributes('src')).toBe(`/api/files?path=${encodeURIComponent('/work/garden/assets/logo.png')}`)
    expect(wrapper.getComponent({ name: 'DocumentTypeArt' }).props('ext')).toBe('pdf')

    await wrapper.get('button[aria-label="List view"]').trigger('click')
    expect(wrapper.get('li img').attributes('src')).toContain('logo.png')
    expect(wrapper.find('i[data-icon="mdi:file-pdf-box"]').exists()).toBe(true)

    await wrapper.get('li img').trigger('error')
    expect(wrapper.find('li img').exists()).toBe(false)
  })

  test('renders markdown files in the preview', async () => {
    vi.spyOn(api.projects, 'listFiles').mockResolvedValue({ path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'file', size: 12 }] })
    vi.spyOn(api.projects, 'readFile').mockResolvedValue({ kind: 'file', name: 'README.md', content: '# Garden' })
    const wrapper = mountTab()
    await flushPromises()

    await rowButton(wrapper, 'README.md').trigger('click')
    await flushPromises()

    expect(wrapper.get('.preview .rich').text()).toBe('# Garden')
    expect(wrapper.find('.preview pre').exists()).toBe(false)
  })

  test('previews other text files as plain text', async () => {
    vi.spyOn(api.projects, 'listFiles').mockResolvedValue({ path: '', entries: [{ name: 'notes.txt', path: 'notes.txt', type: 'file', size: 12 }] })
    const read = vi.spyOn(api.projects, 'readFile').mockResolvedValue({ kind: 'file', name: 'notes.txt', content: '# Garden' })
    const wrapper = mountTab()
    await flushPromises()

    await rowButton(wrapper, 'notes.txt').trigger('click')
    await flushPromises()

    expect(read).toHaveBeenCalledWith('project-1', 'notes.txt')
    expect(wrapper.get('.preview').attributes('data-title')).toBe('notes.txt')
    expect(wrapper.get('.preview pre').text()).toBe('# Garden')
  })

  test('disables files over the size cap', async () => {
    vi.spyOn(api.projects, 'listFiles').mockResolvedValue({ path: '', entries: [{ name: 'video.mov', path: 'video.mov', type: 'file', size: 30 * 1024 * 1024 }] })
    const wrapper = mountTab()
    await flushPromises()

    const button = rowButton(wrapper, 'video.mov')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.text()).toContain('Over 20 MB')
  })
})
