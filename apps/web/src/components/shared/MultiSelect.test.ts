import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import MultiSelect from './MultiSelect.vue'

const options = [
  { value: 'personal', label: 'Personal' },
  { value: 'work', label: 'Work' },
]

describe('MultiSelect', () => {
  test('supports all-selected summary and bulk selection actions', async () => {
    const wrapper = mount(MultiSelect, {
      props: {
        modelValue: ['personal', 'work'],
        options,
        showBulkActions: true,
        allSelectedLabel: 'All memory folders',
      },
    })

    expect(wrapper.get('button').text()).toContain('All memory folders')
    await wrapper.get('button').trigger('click')
    const unselect = wrapper.findAll('button').find((button) => button.text() === 'Unselect All')
    expect(unselect).toBeDefined()
    await unselect!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([[]])

    await wrapper.setProps({ modelValue: [] })
    const select = wrapper.findAll('button').find((button) => button.text() === 'Select All')
    await select!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['personal', 'work']])
  })
})
