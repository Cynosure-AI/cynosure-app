<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { SlashOption } from '../../../utils/slash-commands'

const props = defineProps<{
  id: string
  options: SlashOption[]
  activeIndex: number
  /** Show group headings; only meaningful while the list is in command order. */
  grouped: boolean
}>()

const emit = defineEmits<{
  select: [option: SlashOption]
  hover: [index: number]
}>()

const root = ref<HTMLElement | null>(null)
const brokenIcons = ref<Set<string>>(new Set())
const LIST_HEIGHT = 288
const FOOTER_HEIGHT = 34
const GAP = 8
const VIEWPORT_PADDING = 12
const openAbove = ref(true)
const listMaxHeight = ref(LIST_HEIGHT)

/** Open above the composer unless there is clearly more room below (the centered empty-chat layout). */
function updatePlacement(): void {
  const anchor = root.value?.parentElement?.getBoundingClientRect()
  if (!anchor) return
  const above = anchor.top - GAP - VIEWPORT_PADDING
  const below = window.innerHeight - anchor.bottom - GAP - VIEWPORT_PADDING
  openAbove.value = above >= LIST_HEIGHT + FOOTER_HEIGHT || above >= below
  listMaxHeight.value = Math.max(96, Math.min(LIST_HEIGHT, (openAbove.value ? above : below) - FOOTER_HEIGHT))
}

function optionId(index: number): string {
  return `${props.id}-option-${index}`
}

function showsGroup(index: number): boolean {
  const group = props.options[index]?.group
  return props.grouped && Boolean(group) && group !== props.options[index - 1]?.group
}

function markIconBroken(key: string): void {
  brokenIcons.value = new Set([...brokenIcons.value, key])
}

watch(() => props.activeIndex, async (index) => {
  await nextTick()
  document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' })
})

onMounted(() => {
  updatePlacement()
  window.addEventListener('resize', updatePlacement)
})
onBeforeUnmount(() => window.removeEventListener('resize', updatePlacement))

defineExpose({ optionId })
</script>

<template>
  <div
    ref="root"
    class="absolute inset-x-0 z-30 overflow-hidden rounded-xl border border-theme-700 bg-theme-900 text-theme-200 shadow-2xl"
    :class="openAbove ? 'bottom-full mb-2' : 'top-full mt-2'"
  >
    <div
      :id="id"
      role="listbox"
      aria-label="Commands"
      class="overflow-y-auto p-1.5"
      :style="{ maxHeight: `${listMaxHeight}px` }"
    >
      <template
        v-for="(option, index) in options"
        :key="option.key"
      >
        <div
          v-if="showsGroup(index)"
          class="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted first:pt-1"
          aria-hidden="true"
        >
          {{ option.group }}
        </div>
        <div
          :id="optionId(index)"
          role="option"
          :aria-selected="index === activeIndex"
          class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5"
          :class="[index === activeIndex ? 'bg-theme-800' : '', option.unavailable ? 'opacity-55' : '']"
          :aria-disabled="option.unavailable ? 'true' : undefined"
          @mousedown.prevent
          @mousemove="index !== activeIndex && emit('hover', index)"
          @click="emit('select', option)"
        >
          <span class="flex h-5 w-5 shrink-0 items-center justify-center">
            <img
              v-if="option.iconUrl && !brokenIcons.has(option.key)"
              :src="option.iconUrl"
              alt=""
              class="h-4.5 w-4.5 rounded-sm object-contain"
              @error="markIconBroken(option.key)"
            >
            <Icon
              v-else-if="option.icon"
              :icon="option.icon"
              class="h-4 w-4"
              :class="index === activeIndex ? 'text-theme-100' : 'text-ink-secondary'"
            />
          </span>
          <span class="shrink-0 text-sm text-theme-100">{{ option.label }}</span>
          <span
            v-if="option.hint"
            class="shrink-0 text-xs text-ink-faint"
          >‹{{ option.hint }}›</span>
          <span
            v-if="option.description || option.unavailable"
            class="min-w-0 flex-1 truncate text-xs text-ink-muted"
          >{{ option.unavailable ? `${option.description} — ${option.unavailable}` : option.description }}</span>
          <span
            v-else
            class="flex-1"
          />
          <span
            v-if="option.detail"
            class="max-w-40 shrink-0 truncate text-[11px] text-ink-muted"
          >{{ option.detail }}</span>
          <span
            v-if="option.state"
            class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
            :class="option.state === 'on'
              ? 'bg-accent-600/20 text-accent-fg'
              : option.state === 'mixed'
                ? 'bg-amber-500/15 text-status-warning'
                : 'bg-theme-800 text-ink-muted'"
          >{{ option.state === 'mixed' ? 'Some' : option.state }}</span>
        </div>
      </template>
    </div>
    <div class="hidden gap-3 border-t border-theme-800 px-3 py-1.5 text-[10px] text-ink-muted sm:flex">
      <span><kbd class="font-sans">↑↓</kbd> navigate</span>
      <span><kbd class="font-sans">Tab</kbd> complete</span>
      <span><kbd class="font-sans">Enter</kbd> run</span>
      <span><kbd class="font-sans">Esc</kbd> close</span>
    </div>
  </div>
</template>
