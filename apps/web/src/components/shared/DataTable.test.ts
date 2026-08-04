import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import DataTable, { type Column } from './DataTable.vue'

interface Item {
  id: string
  name: string
  enabled: boolean
}

const columns: Column<Item>[] = [
  { key: 'name', label: 'Name', width: 'minmax(260px, 2fr)', sortable: true },
  { key: 'enabled', label: 'Enabled', width: '120px', class: 'text-right', sortable: true },
]

function renderedNames(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-testid="name"]').map(cell => cell.text())
}

describe('DataTable', () => {
  test('keeps one-time initial ordering stable when a sorted value changes', async () => {
    const wrapper = mount(DataTable<Item>, {
      props: {
        items: [
          { id: 'disabled', name: 'Disabled', enabled: false },
          { id: 'enabled', name: 'Enabled', enabled: true },
        ],
        columns,
        initialSortKey: 'enabled',
        initialSortDirection: 'desc',
        initialSortOnce: true,
      },
      slots: {
        'col-name': '<template #col-name="{ item }"><span data-testid="name">{{ item.name }}</span></template>',
      },
    })

    expect(renderedNames(wrapper)).toEqual(['Enabled', 'Disabled'])

    await wrapper.setProps({
      items: [
        { id: 'disabled', name: 'Disabled', enabled: false },
        { id: 'enabled', name: 'Enabled', enabled: false },
      ],
    })

    expect(renderedNames(wrapper)).toEqual(['Enabled', 'Disabled'])
  })

  test('sorts the full collection before applying pagination', () => {
    const wrapper = mount(DataTable<Item>, {
      props: {
        items: [
          { id: 'c', name: 'Charlie', enabled: true },
          { id: 'a', name: 'Alpha', enabled: true },
          { id: 'b', name: 'Bravo', enabled: true },
        ],
        columns,
        initialSortKey: 'name',
        pagination: true,
        pageSize: 2,
      },
      slots: {
        'col-name': '<template #col-name="{ item }"><span data-testid="name">{{ item.name }}</span></template>',
      },
    })

    expect(renderedNames(wrapper)).toEqual(['Alpha', 'Bravo'])
  })

  test('applies column classes to slotted cells and spans the column minimum width', () => {
    const wrapper = mount(DataTable<Item>, {
      props: {
        items: [{ id: 'a', name: 'Alpha', enabled: true }],
        columns,
      },
      slots: {
        'col-enabled': '<template #col-enabled><span>On</span></template>',
      },
    })

    expect(wrapper.find('.dt-content').attributes('style')).toContain('--dt-min-width: 436px')
    expect(wrapper.findAll('.text-right')).toHaveLength(2)
  })

  test('renders a loading state when there are no items yet', () => {
    const wrapper = mount(DataTable<Item>, {
      props: { items: [], columns, loading: true },
    })

    expect(wrapper.text()).toContain('Loading')
  })
})
