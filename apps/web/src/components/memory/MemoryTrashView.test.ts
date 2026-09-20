import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryTrashView from './MemoryTrashView.vue'

const mocks = vi.hoisted(() => ({
  listDeleted: vi.fn(),
  emptyTrash: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    memoryFolders: {
      listDeleted: mocks.listDeleted,
      emptyTrash: mocks.emptyTrash,
      listRevisions: vi.fn(),
      getRevisionDiff: vi.fn(),
      getRevision: vi.fn(),
      restoreRevision: vi.fn(),
    },
  },
}))

const ModalStub = defineComponent({
  name: 'ModalDialog',
  props: { show: Boolean },
  template: '<div v-if="show" data-testid="confirmation"><slot/><slot name="actions"/></div>',
})

describe('MemoryTrashView', () => {
  beforeEach(() => {
    mocks.listDeleted.mockReset()
    mocks.emptyTrash.mockReset()
    mocks.listDeleted.mockResolvedValue([{
      documentRef: 'deleted#one', folderId: 'folder', fileName: 'deleted.md', revision: 'hash', deletedAt: 1,
    }])
    mocks.emptyTrash.mockResolvedValue({ success: true, deleted: 1 })
  })

  test('requires confirmation and permanently empties all trash entries', async () => {
    const wrapper = mount(MemoryTrashView, {
      global: { stubs: { Icon: true, MemoryInlineDiff: true, ModalDialog: ModalStub } },
    })
    await flushPromises()

    await wrapper.get('button').trigger('click')
    expect(wrapper.get('[data-testid="confirmation"]').text()).toContain('cannot be undone')
    const confirm = wrapper.findAll('[data-testid="confirmation"] button')
      .find(button => button.text().includes('Empty trash permanently'))
    await confirm?.trigger('click')
    await flushPromises()

    expect(mocks.emptyTrash).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('No deleted memories')
  })
})
