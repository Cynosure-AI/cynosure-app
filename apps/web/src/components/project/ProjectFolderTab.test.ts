import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import ProjectFolderTab from './ProjectFolderTab.vue'
import { api } from '../../api/client'
import type { ProjectDto } from '@shared/types'

const project = { id: 'project-1', name: 'Garden Planner', rootPath: '/work/garden' } as ProjectDto

function mountTab() {
  return mount(ProjectFolderTab, {
    props: { project },
    global: {
      stubs: {
        Icon: true,
        ModalDialog: { props: ['show', 'title'], template: '<div v-if="show" class="preview" :data-title="title"><slot /></div>' },
      },
    },
  })
}

function rowButton(wrapper: ReturnType<typeof mountTab>, label: string) {
  return wrapper.findAll('li button').find((button) => button.text().includes(label))!
}

describe('ProjectFolderTab', () => {
  afterEach(() => vi.restoreAllMocks())

  test('lists the project folder and opens subfolders', async () => {
    const list = vi.spyOn(api.projects, 'listFiles').mockImplementation(async (_id, opts = {}) => opts.path === 'src'
      ? { path: 'src', entries: [{ name: 'app.ts', path: 'src/app.ts', type: 'file', size: 2048 }] }
      : { path: '', entries: [{ name: 'src', path: 'src', type: 'directory' }, { name: 'README.md', path: 'README.md', type: 'file', size: 12 }] })
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.text()).toContain('/work/garden')
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['src', 'README.md12 B'])

    await rowButton(wrapper, 'src').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith('project-1', expect.objectContaining({ path: 'src' }))
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['app.ts2.0 KB'])
    expect(wrapper.get('nav').text()).toContain('src')
  })

  test('previews a text file when it is clicked', async () => {
    vi.spyOn(api.projects, 'listFiles').mockResolvedValue({ path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'file', size: 12 }] })
    const read = vi.spyOn(api.projects, 'readFile').mockResolvedValue({ kind: 'file', name: 'README.md', content: '# Garden' })
    const wrapper = mountTab()
    await flushPromises()

    await rowButton(wrapper, 'README.md').trigger('click')
    await flushPromises()

    expect(read).toHaveBeenCalledWith('project-1', 'README.md')
    expect(wrapper.get('.preview').attributes('data-title')).toBe('README.md')
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
