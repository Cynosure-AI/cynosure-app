<script setup lang="ts" generic="T extends { id: string }">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { Icon } from '@iconify/vue'

export interface Column<TItem = unknown> {
  key: string
  label: string
  /** Accessible name for columns whose visible label is empty (icon-only columns). */
  ariaLabel?: string
  /** Complete CSS grid track. Kept for fixed/fully custom column layouts. */
  width?: string  // e.g., '120px', 'minmax(0,1.75fr)'
  /** Minimum track size. When set, the column grows into otherwise unused space. */
  minWidth?: string
  /** Share of unused space received by a minWidth column. */
  grow?: number
  class?: string   // Custom CSS classes for column content
  sortable?: boolean
  sortValue?: (item: TItem) => string | number | boolean | null | undefined
  filterValue?: (item: TItem) => unknown
  /** Opens the matching edit-col-{key} slot on double click, Enter, or F2. */
  editable?: boolean
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
  initialSortOnce?: boolean
  /** Keep broad item groups together while sorting within each group. */
  sortGroupValue?: (item: TItem) => string | number | boolean | null | undefined
  showHeader?: boolean
  emptyMessage?: string
  loading?: boolean
  rowClass?: (item: TItem) => string | undefined
  rowClickable?: boolean
  rowDraggable?: boolean | ((item: TItem) => boolean)
  pagination?: boolean
  page?: number
  pageSize?: number
  paginationPosition?: 'top' | 'bottom' | 'both'
  filterText?: string
  filterPredicate?: (item: TItem, normalizedQuery: string) => boolean
}

const props = withDefaults(defineProps<Props<T>>(), {
  showHeader: true,
  emptyMessage: 'No items found',
  selectedIds: () => [],
  initialSortKey: null,
  initialSortDirection: 'asc',
  initialSortOnce: false,
  sortGroupValue: undefined,
  selectionColumn: () => ({
    width: '40px',
  }),
  rowClass: undefined,
  rowSelectable: undefined,
  rowClickable: false,
  rowDraggable: false,
  pagination: false,
  page: 0,
  pageSize: 30,
  paginationPosition: 'bottom',
  filterText: '',
  filterPredicate: undefined,
})

const emit = defineEmits<{
  'update:selectedIds': [value: string[]]
  'update:page': [value: number]
  'row-click': [item: T, event: MouseEvent | KeyboardEvent]
  'row-dblclick': [item: T, event: MouseEvent]
  'row-contextmenu': [item: T, event: MouseEvent]
  'row-dragstart': [item: T, event: DragEvent]
  'row-dragover': [item: T, event: DragEvent]
  'row-dragleave': [item: T, event: DragEvent]
  'row-drop': [item: T, event: DragEvent]
  'row-dragend': [item: T, event: DragEvent]
  'selection-change': [value: string[]]
  'page-change': [value: number]
  'visible-items-change': [value: T[]]
  'cell-edit-start': [item: T, column: Column<T>, items: T[]]
  'cell-edit-end': [item: T, column: Column<T>, saved: boolean]
  'sort-change': [key: string | null, direction: 'asc' | 'desc']
}>()

const showSelectableColumn = computed(() => Boolean(props.selectable))
const sortColumnKey = ref<string | null>(props.initialSortOnce ? null : props.initialSortKey)
const sortDirection = ref<'asc' | 'desc'>(props.initialSortDirection)
const selectionAnchorId = ref<string | null>(null)
const editingCell = ref<{ itemId: string; columnKey: string } | null>(null)
const editingAnchorEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLElement | null>(null)
const editorStyle = ref<CSSProperties>({})
const editorPlacement = ref<'top' | 'bottom'>('bottom')

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
    .map(columnTrack)
    .join(' ')
  const selectionWidth = props.selectionColumn?.width || '40px'
  return showSelectableColumn.value ? `${selectionWidth} ${columnWidths}` : columnWidths
})

function columnTrack(column: Column<T>): string {
  if (column.minWidth) {
    if (column.grow === 0) return column.minWidth
    const grow = Math.max(0.01, column.grow ?? 1)
    return `minmax(${column.minWidth}, ${grow}fr)`
  }
  return withFrMinimum(column.width || 'minmax(0, 1fr)')
}

function minimumWidthPx(width: string, fallback = 150): number {
  const value = withFrMinimum(width).trim()
  const fixed = value.match(/^(\d*\.?\d+)px$/)
  if (fixed) return Number(fixed[1])
  const minmax = value.match(/^minmax\(\s*(\d*\.?\d+)px\s*,/)
  return minmax ? Number(minmax[1]) : fallback
}

// Row borders live outside the grid itself. Give their shared wrapper the same
// minimum width as the columns so separators and expanded rows span overflow.
const gridMinWidth = computed(() => {
  const widths = props.columns.map(column => minimumWidthPx(column.minWidth || column.width || 'minmax(0, 1fr)'))
  if (showSelectableColumn.value) {
    widths.unshift(minimumWidthPx(props.selectionColumn?.width || '40px', 40))
  }
  const gaps = Math.max(0, widths.length - 1) * 16
  const horizontalPadding = 40
  return `${widths.reduce((total, width) => total + width, 0) + gaps + horizontalPadding}px`
})

function toggleSelection(id: string, event?: MouseEvent) {
  const item = props.items.find(candidate => candidate.id === id)
  if (item && !isSelectable(item)) return

  const current = new Set(props.selectedIds)
  const anchorIndex = selectionAnchorId.value
    ? visibleItems.value.findIndex(candidate => candidate.id === selectionAnchorId.value)
    : -1
  const clickedIndex = visibleItems.value.findIndex(candidate => candidate.id === id)

  if (event?.shiftKey && anchorIndex >= 0 && clickedIndex >= 0) {
    const start = Math.min(anchorIndex, clickedIndex)
    const end = Math.max(anchorIndex, clickedIndex)
    for (const rangeItem of visibleItems.value.slice(start, end + 1)) {
      if (isSelectable(rangeItem)) current.add(rangeItem.id)
    }
  } else if (current.has(id)) {
    current.delete(id)
  } else {
    current.add(id)
  }

  if (!event?.shiftKey || anchorIndex < 0) selectionAnchorId.value = id
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
  if (!props.rowClickable) return
  const target = event.target as HTMLElement
  if (target.closest('button, a, input, select, textarea, [role="button"], [role="combobox"]')) return
  if (editingCell.value) return
  emit('row-click', item, event)
}

function handleRowDoubleClick(item: T, event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('button, a, input, select, textarea, [role="button"], [role="combobox"]')) return
  if (editingCell.value) return
  emit('row-dblclick', item, event)
}

function handleRowContextMenu(item: T, event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('input, select, textarea')) return
  emit('row-contextmenu', item, event)
}

function handleRowKeydown(item: T, event: KeyboardEvent) {
  if (!props.rowClickable || event.key !== 'Enter') return
  const target = event.target as HTMLElement
  if (target !== event.currentTarget) return
  emit('row-click', item, event)
}

function isDraggable(item: T): boolean {
  return typeof props.rowDraggable === 'function' ? props.rowDraggable(item) : props.rowDraggable
}

function handleDragStart(item: T, event: DragEvent) {
  emit('row-dragstart', item, event)
}

function handleDragOver(item: T, event: DragEvent) {
  emit('row-dragover', item, event)
}

function handleDragLeave(item: T, event: DragEvent) {
  emit('row-dragleave', item, event)
}

function handleDrop(item: T, event: DragEvent) {
  emit('row-drop', item, event)
}

function handleDragEnd(item: T, event: DragEvent) {
  emit('row-dragend', item, event)
}

function isSelected(id: string): boolean {
  return props.selectedIds.includes(id)
}

function isSelectable(item: T): boolean {
  return props.rowSelectable ? props.rowSelectable(item) : true
}

/** Names the column and its sort state; aria-sort is only valid on table header cells. */
function sortButtonLabel(col: Column<T>): string {
  const name = col.label || col.ariaLabel || col.key
  if (sortColumnKey.value !== col.key) return `Sort by ${name}`
  return `${name}, sorted ${sortDirection.value === 'asc' ? 'ascending' : 'descending'}`
}

function toggleSort(column: Column<T>) {
  if (!column.sortable) return

  if (sortColumnKey.value !== column.key) {
    sortColumnKey.value = column.key
    sortDirection.value = 'asc'
    emit('sort-change', sortColumnKey.value, sortDirection.value)
    return
  }

  if (sortDirection.value === 'asc') {
    sortDirection.value = 'desc'
    emit('sort-change', sortColumnKey.value, sortDirection.value)
    return
  }

  sortColumnKey.value = null
  sortDirection.value = 'asc'
  emit('sort-change', sortColumnKey.value, sortDirection.value)
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
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

function compareForSort(
  a: string | number | boolean | null | undefined,
  b: string | number | boolean | null | undefined,
  direction: 1 | -1,
): number {
  // Missing values stay at the end in either direction.
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return compareValues(a, b) * direction
}

const initialOrderById = new Map<string, number>()
const initialOrderVersion = ref(0)
let initialOrderApplied = false
watch(() => props.items, (items) => {
  if (initialOrderApplied || !items.length || !props.initialSortOnce || !props.initialSortKey) return
  const column = props.columns.find(col => col.key === props.initialSortKey)
  if (!column?.sortable) return
  const direction = props.initialSortDirection === 'asc' ? 1 : -1
  const initiallySorted = [...items].sort(
    (a, b) => compareForSort(valueForSort(a, column), valueForSort(b, column), direction),
  )
  initiallySorted.forEach((item, index) => initialOrderById.set(item.id, index))
  initialOrderApplied = true
  initialOrderVersion.value++
}, { immediate: true })

function valueForFilter(item: T, column: Column<T>): unknown {
  return column.filterValue
    ? column.filterValue(item)
    : (item as Record<string, unknown>)[column.key]
}

function searchableText(value: unknown): string {
  if (Array.isArray(value)) return value.map(searchableText).join(' ')
  if (value == null) return ''
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(searchableText).join(' ')
  return String(value)
}

const filteredItems = computed(() => {
  const query = props.filterText.trim().toLocaleLowerCase()
  if (!query) return [...props.items]
  if (props.filterPredicate) return props.items.filter(item => props.filterPredicate?.(item, query))
  return props.items.filter(item => props.columns.some(column =>
    searchableText(valueForFilter(item, column)).toLocaleLowerCase().includes(query),
  ))
})

const sortedItems = computed(() => {
  void initialOrderVersion.value
  const baseItems = [...filteredItems.value]
  if (initialOrderById.size) {
    baseItems.sort((a, b) => {
      const aRank = initialOrderById.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const bRank = initialOrderById.get(b.id) ?? Number.MAX_SAFE_INTEGER
      return aRank - bRank
    })
  }

  if (!sortColumnKey.value) return baseItems

  const column = props.columns.find(col => col.key === sortColumnKey.value)
  if (!column?.sortable) return baseItems

  const direction = sortDirection.value === 'asc' ? 1 : -1
  return baseItems.sort((a, b) => {
    const groupComparison = props.sortGroupValue
      ? compareForSort(props.sortGroupValue(a), props.sortGroupValue(b), 1)
      : 0
    return groupComparison || compareForSort(valueForSort(a, column), valueForSort(b, column), direction)
  })
})

const normalizedPageSize = computed(() => Math.max(1, Math.floor(props.pageSize)))
const pageCount = computed(() => Math.max(1, Math.ceil(sortedItems.value.length / normalizedPageSize.value)))
const currentPage = computed(() => Math.min(Math.max(0, props.page), pageCount.value - 1))
const visibleItems = computed(() => {
  if (!props.pagination) return sortedItems.value
  const start = currentPage.value * normalizedPageSize.value
  return sortedItems.value.slice(start, start + normalizedPageSize.value)
})
watch(visibleItems, items => emit('visible-items-change', items), { immediate: true })
watch(() => props.selectedIds, selectedIds => {
  if (selectedIds.length === 0) selectionAnchorId.value = null
})
const showPagination = computed(() => props.pagination && sortedItems.value.length > normalizedPageSize.value)
const showTopPagination = computed(() => showPagination.value && (props.paginationPosition === 'top' || props.paginationPosition === 'both'))
const showBottomPagination = computed(() => showPagination.value && (props.paginationPosition === 'bottom' || props.paginationPosition === 'both'))

function setPage(nextPage: number) {
  const normalized = Math.min(Math.max(0, nextPage), pageCount.value - 1)
  emit('update:page', normalized)
  emit('page-change', normalized)
}

watch([pageCount, () => props.page], () => {
  if (props.page !== currentPage.value) setPage(currentPage.value)
}, { immediate: true })

const selectableVisibleItems = computed(() => visibleItems.value.filter(isSelectable))
const pageSelectedCount = computed(() => selectableVisibleItems.value.filter((item) => props.selectedIds.includes(item.id)).length)
const allSelected = computed(() => pageSelectedCount.value === selectableVisibleItems.value.length && selectableVisibleItems.value.length > 0)
const someSelected = computed(() => pageSelectedCount.value > 0 && pageSelectedCount.value < selectableVisibleItems.value.length)
const anySelected = computed(() => props.selectedIds.length > 0)

const editingItem = computed(() => {
  if (!editingCell.value) return null
  return props.items.find(item => item.id === editingCell.value?.itemId) || null
})
const editingColumn = computed(() => {
  if (!editingCell.value) return null
  return props.columns.find(column => column.key === editingCell.value?.columnKey) || null
})
const editingItems = computed(() => {
  if (!editingItem.value) return []
  if (!props.selectedIds.includes(editingItem.value.id)) return [editingItem.value]
  const ids = new Set(props.selectedIds)
  return props.items.filter(item => ids.has(item.id))
})

function updateEditorPosition(): void {
  const anchor = editingAnchorEl.value
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const viewportPadding = 12
  const gap = 6
  const width = Math.min(Math.max(rect.width, 340), window.innerWidth - viewportPadding * 2)
  const left = Math.min(Math.max(rect.left, viewportPadding), window.innerWidth - width - viewportPadding)
  const roomBelow = window.innerHeight - rect.bottom
  const roomAbove = rect.top
  editorPlacement.value = roomBelow < 300 && roomAbove > roomBelow ? 'top' : 'bottom'
  editorStyle.value = editorPlacement.value === 'bottom'
    ? { position: 'fixed', left: `${left}px`, top: `${rect.bottom + gap}px`, width: `${width}px` }
    : { position: 'fixed', left: `${left}px`, bottom: `${window.innerHeight - rect.top + gap}px`, width: `${width}px` }
}

function startEditing(item: T, column: Column<T>, event: MouseEvent | KeyboardEvent): void {
  if (!column.editable) return
  const target = event.target as HTMLElement
  if (event instanceof MouseEvent && target.closest('button, a, input, select, textarea, [role="button"], [role="combobox"]')) return
  editingAnchorEl.value = event.currentTarget as HTMLElement
  editingCell.value = { itemId: item.id, columnKey: column.key }
  nextTick(updateEditorPosition)
  emit('cell-edit-start', item, column, editingItems.value)
}

function handleCellKeydown(item: T, column: Column<T>, event: KeyboardEvent): void {
  if (!column.editable || (event.key !== 'Enter' && event.key !== 'F2')) return
  event.preventDefault()
  event.stopPropagation()
  startEditing(item, column, event)
}

function closeEditor(saved = false): void {
  if (editingItem.value && editingColumn.value) {
    emit('cell-edit-end', editingItem.value, editingColumn.value, saved)
  }
  editingCell.value = null
  editingAnchorEl.value = null
}

function handleDocumentPointerDown(event: MouseEvent): void {
  if (!editingCell.value) return
  const target = event.target as Node
  if (editorEl.value?.contains(target) || editingAnchorEl.value?.contains(target)) return
  closeEditor(false)
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && editingCell.value) closeEditor(false)
}

watch([filteredItems, () => props.columns], () => {
  if (editingCell.value && (!editingItem.value || !editingColumn.value)) closeEditor(false)
})

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentPointerDown)
  window.addEventListener('resize', updateEditorPosition)
  window.addEventListener('scroll', updateEditorPosition, true)
  window.addEventListener('keydown', handleWindowKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentPointerDown)
  window.removeEventListener('resize', updateEditorPosition)
  window.removeEventListener('scroll', updateEditorPosition, true)
  window.removeEventListener('keydown', handleWindowKeydown)
})

defineExpose({ startEditing, closeEditor })
</script>

<template>
  <div class="data-table overflow-x-auto overscroll-x-contain rounded-xl border border-table-border bg-table-surface">
    <div
      class="dt-content"
      :style="{ '--dt-min-width': gridMinWidth }"
    >
      <div
        v-if="showTopPagination"
        class="dt-pagination flex items-center justify-center gap-2 border-b border-table-border bg-table-header px-4 py-2"
      >
        <button
          type="button"
          :disabled="currentPage === 0"
          class="px-2 py-1 text-xs text-ink-secondary hover:text-theme-200 disabled:opacity-30"
          @click="setPage(currentPage - 1)"
        >
          Prev
        </button>
        <span class="text-xs text-ink-muted">{{ currentPage + 1 }} / {{ pageCount }}</span>
        <button
          type="button"
          :disabled="currentPage >= pageCount - 1"
          class="px-2 py-1 text-xs text-ink-secondary hover:text-theme-200 disabled:opacity-30"
          @click="setPage(currentPage + 1)"
        >
          Next
        </button>
      </div>

      <!-- Header Row -->
      <div
        v-if="showHeader"
        class="dt-header dt-grid grid items-start gap-4 border-b border-table-border bg-table-header px-5 py-3 text-[11px] uppercase tracking-wider text-ink-secondary"
        :style="{ '--dt-cols': gridColsTemplate }"
      >
        <!-- Select All Checkbox -->
        <div
          v-if="showSelectableColumn"
          class="flex items-center"
        >
          <input
            type="checkbox"
            class="h-4 w-4 cursor-pointer rounded border-theme-600 bg-theme-900 text-accent-fg focus:outline-none focus:ring-0 focus-visible:ring-2 focus-visible:ring-accent-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-theme-950"
            :checked="allSelected"
            :indeterminate="someSelected"
            :aria-label="allSelected ? 'Deselect all visible rows' : 'Select all visible rows'"
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
            :aria-label="sortButtonLabel(col)"
            @click="toggleSort(col)"
          >
            <span class="truncate">{{ col.label }}</span>
            <Icon
              :icon="sortIcon(col)"
              class="h-3.5 w-3.5 shrink-0"
              :class="sortColumnKey === col.key ? 'text-accent-fg' : 'text-ink-faint'"
            />
          </button>
          <template v-else>
            {{ col.label }}
          </template>
        </div>
      </div>

      <!-- Data Rows -->
      <div v-if="visibleItems.length">
        <div
          v-for="item in visibleItems"
          :key="item.id"
          class="group border-b border-table-border/70 transition-colors last:border-b-0 hover:bg-table-hover"
          :class="[rowClass?.(item), { 'cursor-pointer': rowClickable, 'bg-table-selected': isSelected(item.id) }]"
          :draggable="isDraggable(item)"
          :tabindex="rowClickable ? 0 : undefined"
          :aria-selected="showSelectableColumn ? isSelected(item.id) : undefined"
          @click="handleRowClick(item, $event)"
          @dblclick="handleRowDoubleClick(item, $event)"
          @contextmenu="handleRowContextMenu(item, $event)"
          @keydown="handleRowKeydown(item, $event)"
          @dragstart.stop="handleDragStart(item, $event)"
          @dragover="handleDragOver(item, $event)"
          @dragleave="handleDragLeave(item, $event)"
          @drop="handleDrop(item, $event)"
          @dragend="handleDragEnd(item, $event)"
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
                class="h-4 w-4 cursor-pointer rounded border-theme-600 bg-theme-900 text-accent-fg opacity-100 transition-opacity focus:outline-none focus:ring-0 focus-visible:ring-2 focus-visible:ring-accent-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-theme-950 sm:opacity-0 sm:group-hover:opacity-100"
                :class="{ 'sm:!opacity-100': anySelected || isSelected(item.id) }"
                :checked="isSelected(item.id)"
                :aria-label="`${isSelected(item.id) ? 'Deselect' : 'Select'} row`"
                @click.stop="toggleSelection(item.id, $event)"
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
              <div
                class="dt-cell relative"
                :class="[col.class, { 'dt-cell-editable': col.editable }]"
                :tabindex="col.editable ? 0 : undefined"
                :title="col.editable ? 'Double-click to edit' : undefined"
                @click="col.editable && $event.stopPropagation()"
                @dblclick="startEditing(item, col, $event)"
                @keydown="handleCellKeydown(item, col, $event)"
              >
                <slot
                  :name="`col-${col.key}`"
                  :item="item"
                  :column="col"
                >
                  <!-- Fallback: render simple text if no slot provided -->
                  <div>
                    {{ (item as Record<string, unknown>)[col.key] }}
                  </div>
                </slot>
                <Icon
                  v-if="col.editable"
                  icon="lucide:pencil"
                  class="dt-edit-hint absolute right-0 top-0 h-3 w-3 text-ink-faint opacity-0 transition-opacity"
                />
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
        v-else-if="loading"
        class="flex items-center justify-center gap-2 px-5 py-10 text-sm text-ink-muted"
      >
        <Icon
          icon="lucide:loader-2"
          class="h-4 w-4 animate-spin"
        />
        Loading…
      </div>

      <div
        v-else
        class="px-5 py-10 text-center text-sm text-ink-muted"
      >
        {{ emptyMessage }}
      </div>

      <div
        v-if="showBottomPagination"
        class="dt-pagination flex items-center justify-center gap-2 border-t border-table-border bg-table-header px-4 py-2"
      >
        <button
          type="button"
          :disabled="currentPage === 0"
          class="px-2 py-1 text-xs text-ink-secondary hover:text-theme-200 disabled:opacity-30"
          @click="setPage(currentPage - 1)"
        >
          Prev
        </button>
        <span class="text-xs text-ink-muted">{{ currentPage + 1 }} / {{ pageCount }}</span>
        <button
          type="button"
          :disabled="currentPage >= pageCount - 1"
          class="px-2 py-1 text-xs text-ink-secondary hover:text-theme-200 disabled:opacity-30"
          @click="setPage(currentPage + 1)"
        >
          Next
        </button>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="editingItem && editingColumn"
      ref="editorEl"
      class="z-70 rounded-xl border border-theme-700 bg-theme-900 p-3 shadow-2xl"
      :style="editorStyle"
      role="dialog"
      :aria-label="`Edit ${editingColumn.label}`"
      @click.stop
    >
      <div class="mb-2 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="truncate text-xs font-semibold text-theme-200">
            Edit {{ editingColumn.label }}
          </p>
          <p
            v-if="editingItems.length > 1"
            class="mt-0.5 text-[10px] text-accent-fg"
          >
            Applies to {{ editingItems.length }} selected rows
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200"
          aria-label="Close editor"
          @click="closeEditor(false)"
        >
          <Icon
            icon="lucide:x"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
      <slot
        :name="`edit-col-${editingColumn.key}`"
        :item="editingItem"
        :items="editingItems"
        :column="editingColumn"
        :placement="editorPlacement"
        :finish="() => closeEditor(true)"
        :cancel="() => closeEditor(false)"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.dt-grid {
  grid-template-columns: var(--dt-cols);
  width: 100%;
}

.dt-content {
  min-width: var(--dt-min-width);
}

.dt-cell-editable:focus-visible {
  border-radius: 0.375rem;
  outline: 1px solid color-mix(in oklab, var(--color-accent-500) 65%, transparent);
  outline-offset: 4px;
}

.dt-cell-editable:hover .dt-edit-hint,
.dt-cell-editable:focus-visible .dt-edit-hint {
  opacity: 1;
}
</style>
