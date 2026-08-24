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

  test('applies one-time initial ordering after asynchronous items arrive', async () => {
    const wrapper = mount(DataTable<Item>, {
      props: {
        items: [],
        columns,
        initialSortKey: 'enabled',
        initialSortDirection: 'desc',
        initialSortOnce: true,
      },
      slots: {
        'col-name': '<template #col-name="{ item }"><span data-testid="name">{{ item.name }}</span></template>',
      },
    })

    await wrapper.setProps({
      items: [
        { id: 'disabled', name: 'Disabled', enabled: false },
        { id: 'enabled', name: 'Enabled', enabled: true },
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
    expect(wrapper.get('.dt-content').text()).toContain('Prev')
    expect(wrapper.get('.dt-content').text()).toContain('1 / 2')
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

  test('grows content-sized columns from their declared minimums', () => {
    const fluidColumns: Column<Item>[] = [
      { key: 'name', label: 'Name', minWidth: '100px', grow: 2 },
      { key: 'enabled', label: 'Enabled', minWidth: '70px' },
    ]
    const wrapper = mount(DataTable<Item>, {
      props: {
        items: [{ id: 'a', name: 'Alpha', enabled: true }],
        columns: fluidColumns,
      },
    })

    expect(wrapper.get('.dt-grid').attributes('style')).toContain(
      '--dt-cols: minmax(100px, 2fr) minmax(70px, 1fr)',
    )
    expect(wrapper.get('.dt-content').attributes('style')).toContain('--dt-min-width: 226px')
  })

  test('keeps a zero-growth column at its minimum width', () => {
    const fluidColumns: Column<Item>[] = [
      { key: 'name', label: 'Name', minWidth: '100px', grow: 2 },
      { key: 'enabled', label: 'Enabled', minWidth: '70px', grow: 0 },
    ]
    const wrapper = mount(DataTable<Item>, {
      props: {
        items: [{ id: 'a', name: 'Alpha', enabled: true }],
        columns: fluidColumns,
      },
    })

    expect(wrapper.get('.dt-grid').attributes('style')).toContain(
      '--dt-cols: minmax(100px, 2fr) 70px',
    )
  })

  test('renders a loading state when there are no items yet', () => {
    const wrapper = mount(DataTable<Item>, {
      props: { items: [], columns, loading: true },
    })

    expect(wrapper.text()).toContain('Loading')
  })

  test('additively selects a visible range with shift-click', async () => {
    const items: Item[] = [
      { id: 'a', name: 'Alpha', enabled: true },
      { id: 'b', name: 'Bravo', enabled: true },
      { id: 'c', name: 'Charlie', enabled: true },
      { id: 'd', name: 'Delta', enabled: true },
    ]
    const wrapper = mount(DataTable<Item>, {
      props: { items, columns, selectable: true, selectedIds: ['d'] },
    })
    const rowCheckboxes = () => wrapper.findAll('input[type="checkbox"]').slice(1)

    await rowCheckboxes()[0].trigger('click')
    expect(wrapper.emitted('update:selectedIds')?.at(-1)?.[0]).toEqual(['d', 'a'])
    await wrapper.setProps({ selectedIds: ['d', 'a'] })

    await rowCheckboxes()[2].trigger('click', { shiftKey: true })
    expect(wrapper.emitted('update:selectedIds')?.at(-1)?.[0]).toEqual(['d', 'a', 'b', 'c'])
  })

  test('skips non-selectable rows in a shift-click range', async () => {
    const items: Item[] = [
      { id: 'a', name: 'Alpha', enabled: true },
      { id: 'b', name: 'Bravo', enabled: false },
      { id: 'c', name: 'Charlie', enabled: true },
    ]
    const wrapper = mount(DataTable<Item>, {
      props: {
        items,
        columns,
        selectable: true,
        selectedIds: [],
        rowSelectable: item => item.enabled,
      },
    })
    const rowCheckboxes = () => wrapper.findAll('input[type="checkbox"]').slice(1)

    await rowCheckboxes()[0].trigger('click')
    await wrapper.setProps({ selectedIds: ['a'] })
    await rowCheckboxes()[1].trigger('click', { shiftKey: true })

    expect(wrapper.emitted('update:selectedIds')?.at(-1)?.[0]).toEqual(['a', 'c'])
  })

  test('filters rows through the shared table pipeline before sorting', () => {
    const wrapper = mount(DataTable<Item>, {
      props: {
        items: [
          { id: 'c', name: 'Charlie', enabled: true },
          { id: 'a', name: 'Alpha', enabled: true },
          { id: 'b', name: 'Bravo', enabled: true },
        ],
        columns,
        filterText: 'ha',
        initialSortKey: 'name',
      },
      slots: {
        'col-name': '<template #col-name="{ item }"><span data-testid="name">{{ item.name }}</span></template>',
      },
    })

    expect(renderedNames(wrapper)).toEqual(['Alpha', 'Charlie'])
  })

  test('opens an editable cell for every selected row and keeps row navigation suppressed', async () => {
    const editableColumns: Column<Item>[] = [
      { key: 'name', label: 'Name', editable: true },
      columns[1],
    ]
    const wrapper = mount(DataTable<Item>, {
      attachTo: document.body,
      props: {
        items: [
          { id: 'a', name: 'Alpha', enabled: true },
          { id: 'b', name: 'Bravo', enabled: true },
        ],
        columns: editableColumns,
        selectedIds: ['a', 'b'],
        selectable: true,
        rowClickable: true,
      },
      slots: {
        'edit-col-name': '<template #edit-col-name="{ items }"><span data-testid="editor-count">{{ items.length }}</span></template>',
      },
    })

    const cell = wrapper.find('.dt-cell-editable')
    await cell.trigger('click')
    expect(wrapper.emitted('row-click')).toBeUndefined()
    await cell.trigger('dblclick')

    expect(document.body.querySelector('[data-testid="editor-count"]')?.textContent).toBe('2')
    expect(wrapper.emitted('cell-edit-start')?.[0]?.[2]).toHaveLength(2)
    wrapper.unmount()
  })
})
