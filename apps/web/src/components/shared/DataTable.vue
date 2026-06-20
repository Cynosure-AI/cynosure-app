<script setup lang="ts" generic="T extends { id: string }">
import { computed, ref } from 'vue'
import { Icon } from '@iconify/vue'

export interface Column<TItem = unknown> {
  key: string
  label: string
  width?: string  // e.g., '120px', 'minmax(0,1.75fr)'
  class?: string   // Custom CSS classes for column content
  sortable?: boolean
  sortValue?: (item: TItem) => string | number | boolean | null | undefined
}

interface SelectionColumn {
  width?: string
}

interface Props<TItem> {
  items: TItem[]
  columns: Column<TItem>[]
  selectable?: boolean
  rowSelectable?: (item: TItem) => boolean
  selectionColumn?: SelectionColumn
  selectedIds?: string[]
  initialSortKey?: string | null
  initialSortDirection?: 'asc' | 'desc'
  showHeader?: boolean
  emptyMessage?: string
  loading?: boolean
  rowClass?: (item: TItem) => string | undefined
  rowDraggable?: boolean | ((item: TItem) => boolean)
  pagination?: boolean
  page?: number
  pageSize?: number
  paginationPosition?: 'top' | 'bottom' | 'both'
}

const props = withDefaults(defineProps<Props<T>>(), {
  showHeader: true,
  emptyMessage: 'No items found',
  selectedIds: () => [],
  initialSortKey: null,
  initialSortDirection: 'asc',
  selectionColumn: () => ({
    width: '40px',
  }),
  rowClass: undefined,
  rowSelectable: undefined,
  rowDraggable: false,
  pagination: false,
  page: 0,
  pageSize: 30,
  paginationPosition: 'bottom',
})

const emit = defineEmits<{
  'update:selectedIds': [value: string[]]
  'update:page': [value: number]
  'row-click': [item: T]
  'row-dragstart': [item: T, event: DragEvent]
  'selection-change': [value: string[]]
  'page-change': [value: number]
}>()

const showSelectableColumn = computed(() => Boolean(props.selectable))
const sortColumnKey = ref<string | null>(props.initialSortKey)
const sortDirection = ref<'asc' | 'desc'>(props.initialSortDirection)

// Ensure fr-based column widths have a minimum so they don't collapse to 0
// when the grid overflows its container (min-width: max-content doesn't expand fr units).
function withFrMinimum(width: string, minPx = 150): string {
  const bare = /^(\d*\.?\d+fr)$/.test(width.trim())
  const zeroMinmax = /^minmax\(\s*0\s*,\s*(\d*\.?\d+fr)\s*\)$/.test(width.trim())
  if (bare) return `minmax(${minPx}px, ${width.trim()})`
  if (zeroMinmax) return width.trim().replace(/^minmax\(\s*0\s*,/, `minmax(${minPx}px,`)
  return width
}

const gridColsTemplate = computed(() => {
  const columnWidths = props.columns
    .map(col => withFrMinimum(col.width || 'minmax(0, 1fr)'))
    .join(' ')
  const selectionWidth = props.selectionColumn?.width || '40px'
  return showSelectableColumn.value ? `${selectionWidth} ${columnWidths}` : columnWidths
})

function toggleSelection(id: string) {
  const item = props.items.find(candidate => candidate.id === id)
  if (item && !isSelectable(item)) return

  const current = new Set(props.selectedIds)
  if (current.has(id)) {
    current.delete(id)
  } else {
    current.add(id)
  }
  const updated = [...current]
  emit('update:selectedIds', updated)
  emit('selection-change', updated)
}

function toggleSelectAll() {
  const current = new Set(props.selectedIds)
  const selectableItems = visibleItems.value.filter(isSelectable)
  if (allSelected.value) {
    for (const item of selectableItems) current.delete(item.id)
  } else {
    for (const item of selectableItems) current.add(item.id)
  }
  const updated = [...current]
  emit('update:selectedIds', updated)
  emit('selection-change', updated)
}

function handleRowClick(item: T, event: MouseEvent) {
  // Don't trigger row click if clicking on checkbox
  const target = event.target as HTMLElement
  if ((target as HTMLInputElement).type === 'checkbox') return
  emit('row-click', item)
}

function isDraggable(item: T): boolean {
  return typeof props.rowDraggable === 'function' ? props.rowDraggable(item) : props.rowDraggable
}

function handleDragStart(item: T, event: DragEvent) {
  emit('row-dragstart', item, event)
}

function isSelected(id: string): boolean {
  return props.selectedIds.includes(id)
}

function isSelectable(item: T): boolean {
  return props.rowSelectable ? props.rowSelectable(item) : true
}

function toggleSort(column: Column<T>) {
  if (!column.sortable) return

  if (sortColumnKey.value !== column.key) {
    sortColumnKey.value = column.key
    sortDirection.value = 'asc'
    return
  }

  if (sortDirection.value === 'asc') {
    sortDirection.value = 'desc'
    return
  }

  sortColumnKey.value = null
  sortDirection.value = 'asc'
}

function sortIcon(column: Column<T>): string {
  if (!column.sortable || sortColumnKey.value !== column.key) return 'lucide:chevrons-up-down'
  return sortDirection.value === 'asc' ? 'lucide:chevron-up' : 'lucide:chevron-down'
}

function valueForSort(item: T, column: Column<T>): string | number | boolean | null | undefined {
  return column.sortValue
    ? column.sortValue(item)
    : (item as Record<string, unknown>)[column.key] as string | number | boolean | null | undefined
}

function compareValues(a: string | number | boolean | null | undefined, b: string | number | boolean | null | undefined): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

const sortedItems = computed(() => {
  if (!sortColumnKey.value) return props.items

  const column = props.columns.find(col => col.key === sortColumnKey.value)
  if (!column?.sortable) return props.items

  const direction = sortDirection.value === 'asc' ? 1 : -1
  return [...props.items].sort((a, b) => compareValues(valueForSort(a, column), valueForSort(b, column)) * direction)
})

const pageCount = computed(() => Math.max(1, Math.ceil(sortedItems.value.length / props.pageSize)))
const currentPage = computed(() => Math.min(Math.max(0, props.page), pageCount.value - 1))
const visibleItems = computed(() => {
  if (!props.pagination) return sortedItems.value
  const start = currentPage.value * props.pageSize
  return sortedItems.value.slice(start, start + props.pageSize)
})
const showPagination = computed(() => props.pagination && sortedItems.value.length > props.pageSize)
const showTopPagination = computed(() => showPagination.value && (props.paginationPosition === 'top' || props.paginationPosition === 'both'))
const showBottomPagination = computed(() => showPagination.value && (props.paginationPosition === 'bottom' || props.paginationPosition === 'both'))

function setPage(nextPage: number) {
  const normalized = Math.min(Math.max(0, nextPage), pageCount.value - 1)
  emit('update:page', normalized)
  emit('page-change', normalized)
}

const selectableVisibleItems = computed(() => visibleItems.value.filter(isSelectable))
const pageSelectedCount = computed(() => selectableVisibleItems.value.filter((item) => props.selectedIds.includes(item.id)).length)
const allSelected = computed(() => pageSelectedCount.value === selectableVisibleItems.value.length && selectableVisibleItems.value.length > 0)
const someSelected = computed(() => pageSelectedCount.value > 0 && pageSelectedCount.value < selectableVisibleItems.value.length)
const anySelected = computed(() => props.selectedIds.length > 0)
</script>

<template>
  <div
    v-if="items.length"
    class="rounded-xl border border-theme-800 overflow-x-auto bg-theme-950/45"
  >
    <div
      v-if="showTopPagination"
      class="flex items-center justify-center gap-2 px-4 py-2 border-b border-theme-800/70 bg-theme-900/40"
    >
      <button
        type="button"
        :disabled="currentPage === 0"
        class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200 disabled:opacity-30"
        @click="setPage(currentPage - 1)"
      >
        Prev
      </button>
      <span class="text-xs text-theme-500">{{ currentPage + 1 }} / {{ pageCount }}</span>
      <button
        type="button"
        :disabled="currentPage >= pageCount - 1"
        class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200 disabled:opacity-30"
        @click="setPage(currentPage + 1)"
      >
        Next
      </button>
    </div>

    <!-- Header Row -->
    <div
      v-if="showHeader"
      class="grid gap-4 px-5 py-3 text-[11px] tracking-wider uppercase text-theme-400 bg-theme-900/70 border-b border-theme-800 dt-grid items-start"
      :style="{ '--dt-cols': gridColsTemplate }"
    >
      <!-- Select All Checkbox -->
      <div
        v-if="showSelectableColumn"
        class="flex items-center"
      >
        <input
          type="checkbox"
          class="h-4 w-4 rounded border-theme-600 bg-theme-900 text-accent-500 focus:ring-accent-500/60 cursor-pointer"
          :checked="allSelected"
          :indeterminate="someSelected"
          @change="toggleSelectAll"
        >
      </div>

      <!-- Column Headers -->
      <div
        v-for="col in columns"
        :key="col.key"
        :class="col.class"
      >
        <button
          v-if="col.sortable"
          type="button"
          class="inline-flex min-w-0 items-center gap-1.5 text-left transition-colors hover:text-theme-200"
          :aria-sort="sortColumnKey === col.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"
          @click="toggleSort(col)"
        >
          <span class="truncate">{{ col.label }}</span>
          <Icon
            :icon="sortIcon(col)"
            class="h-3.5 w-3.5 shrink-0"
            :class="sortColumnKey === col.key ? 'text-accent-400' : 'text-theme-600'"
          />
        </button>
        <template v-else>
          {{ col.label }}
        </template>
      </div>
    </div>

    <!-- Data Rows -->
    <div>
      <div
        v-for="item in visibleItems"
        :key="item.id"
        class="group border-b border-theme-800/70 last:border-b-0 cursor-pointer hover:bg-theme-800/30 transition-colors"
        :class="rowClass?.(item)"
        :draggable="isDraggable(item)"
        @click="handleRowClick(item, $event)"
        @dragstart.stop="handleDragStart(item, $event)"
      >
        <div
          class="grid gap-4 px-5 py-4 items-start dt-grid"
          :style="{ '--dt-cols': gridColsTemplate }"
        >
          <!-- Selection Checkbox -->
          <div
            v-if="showSelectableColumn"
            class="flex items-center pt-1"
            @click.stop
          >
            <input
              v-if="isSelectable(item)"
              type="checkbox"
              class="h-4 w-4 rounded border-theme-600 bg-theme-900 text-accent-500 focus:ring-accent-500/60 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
              :class="{ 'opacity-100': anySelected || isSelected(item.id) }"
              :checked="isSelected(item.id)"
              @change="toggleSelection(item.id)"
            >
            <span
              v-else
              class="h-4 w-4"
            />
          </div>

          <!-- Column Content (via slots) -->
          <template
            v-for="col in columns"
            :key="col.key"
          >
            <div>
              <slot
                :name="`col-${col.key}`"
                :item="item"
                :column="col"
              >
                <!-- Fallback: render simple text if no slot provided -->
                <div :class="col.class">
                  {{ (item as Record<string, unknown>)[col.key] }}
                </div>
              </slot>
            </div>
          </template>
        </div>
        <!-- Full-width expandable section below grid row -->
        <slot
          name="row-expand"
          :item="item"
        />
      </div>
    </div>

    <div
      v-if="showBottomPagination"
      class="flex items-center justify-center gap-2 px-4 py-2 border-t border-theme-800/70 bg-theme-900/40"
    >
      <button
        type="button"
        :disabled="currentPage === 0"
        class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200 disabled:opacity-30"
        @click="setPage(currentPage - 1)"
      >
        Prev
      </button>
      <span class="text-xs text-theme-500">{{ currentPage + 1 }} / {{ pageCount }}</span>
      <button
        type="button"
        :disabled="currentPage >= pageCount - 1"
        class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200 disabled:opacity-30"
        @click="setPage(currentPage + 1)"
      >
        Next
      </button>
    </div>
  </div>

  <!-- Empty State -->
  <div
    v-else-if="!loading"
    class="text-center py-10 text-theme-500"
  >
    {{ emptyMessage }}
  </div>
</template>

<style scoped>
.dt-grid {
  grid-template-columns: var(--dt-cols);
  /* min-content respects minmax() minimums, triggering overflow-x scroll
     when column minimums sum to more than the viewport width. */
  min-width: min-content;
  width: 100%;
}
</style>
