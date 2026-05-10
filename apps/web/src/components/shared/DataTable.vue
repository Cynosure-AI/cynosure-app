<script setup lang="ts" generic="T extends { id: string }">
import { computed } from 'vue'

export interface Column {
  key: string
  label: string
  width?: string  // e.g., '120px', 'minmax(0,1.75fr)'
  class?: string   // Custom CSS classes for column content
}

interface Props<TItem> {
  items: TItem[]
  columns: Column[]
  selectable?: boolean
  selectedIds?: string[]
  showHeader?: boolean
  emptyMessage?: string
  rowClass?: (item: TItem) => string | undefined
}

const props = withDefaults(defineProps<Props<T>>(), {
  showHeader: true,
  emptyMessage: 'No items found',
  selectedIds: () => [],
})

const emit = defineEmits<{
  'update:selectedIds': [value: string[]]
  'row-click': [item: T]
  'selection-change': [value: string[]]
}>()

const gridColsTemplate = computed(() => {
  const columnWidths = props.columns.map(col => col.width || 'minmax(0,1fr)').join(' ')
  return props.selectable ? `40px ${columnWidths}` : columnWidths
})

function toggleSelection(id: string) {
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
  const allSelected = props.selectedIds.length === props.items.length
  const updated = allSelected ? [] : props.items.map(i => i.id)
  emit('update:selectedIds', updated)
  emit('selection-change', updated)
}

function handleRowClick(item: T, event: MouseEvent) {
  // Don't trigger row click if clicking on checkbox
  const target = event.target as HTMLElement
  if ((target as HTMLInputElement).type === 'checkbox') return
  emit('row-click', item)
}

function isSelected(id: string): boolean {
  return props.selectedIds.includes(id)
}

const allSelected = computed(() => props.selectedIds.length === props.items.length && props.items.length > 0)
const someSelected = computed(() => props.selectedIds.length > 0 && props.selectedIds.length < props.items.length)
</script>

<template>
  <div
    v-if="items.length"
    class="rounded-xl border border-zinc-800 overflow-hidden bg-zinc-950/45"
  >
    <!-- Header Row -->
    <div
      v-if="showHeader"
      class="hidden md:grid md:px-5 md:py-3 text-[11px] tracking-wider uppercase text-zinc-400 bg-zinc-900/70 border-b border-zinc-800"
      :style="{ gridTemplateColumns: gridColsTemplate }"
    >
      <!-- Select All Checkbox (hidden on mobile) -->
      <div
        v-if="selectable"
        class="hidden md:flex items-center"
      >
        <input
          type="checkbox"
          class="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500 focus:ring-blue-500/60 cursor-pointer"
          :checked="allSelected"
          :indeterminate="someSelected"
          @change="toggleSelectAll"
        >
      </div>

      <!-- Column Headers -->
      <span
        v-for="col in columns"
        :key="col.key"
        :class="col.class"
      >
        {{ col.label }}
      </span>
    </div>

    <!-- Data Rows -->
    <div>
      <div
        v-for="item in items"
        :key="item.id"
        class="group border-b border-zinc-800/70 last:border-b-0 cursor-pointer hover:bg-zinc-800/30 transition-colors"
        :class="rowClass?.(item)"
        @click="handleRowClick(item, $event)"
      >
        <div
          class="grid gap-3 md:gap-4 px-4 py-4 md:px-5 items-start"
          :style="{ gridTemplateColumns: gridColsTemplate }"
        >
          <!-- Selection Checkbox (hidden on mobile) -->
          <div
            v-if="selectable"
            class="hidden md:flex items-center md:pt-1"
            @click.stop
          >
            <input
              type="checkbox"
              class="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500 focus:ring-blue-500/60 cursor-pointer opacity-0 group-hover:opacity-100 md:opacity-100 transition-opacity"
              :checked="isSelected(item.id)"
              @change="toggleSelection(item.id)"
            >
          </div>

          <!-- Column Content (via slots) -->
          <slot
            v-for="col in columns"
            :key="col.key"
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
      </div>
    </div>
  </div>

  <!-- Empty State -->
  <div
    v-else
    class="text-center py-10 text-zinc-500"
  >
    {{ emptyMessage }}
  </div>
</template>
