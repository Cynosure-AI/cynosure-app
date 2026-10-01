<script setup lang="ts">
import { Icon } from '@iconify/vue'
import ToolNamespaceIcon from './ToolNamespaceIcon.vue'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import RichContent from '../shared/RichContent.vue'
import FileArtifactLinks from './FileArtifactLinks.vue'
import { fileArtifactLinks } from '../../utils/file-artifacts'

type ExecutionRow = {
  name: string
  icon: string
  iconUrl?: string
  internal: boolean
  call: { name: string; arguments: string } | null
  result?: { name: string; success: boolean; output: string; error?: string; images?: string[] }
}

const props = defineProps<{
  rows: ExecutionRow[]
  isActive: boolean
  status: string
  streamingText?: string
}>()
const emit = defineEmits<{ previewImage: [src: string] }>()

function statusLabel(row: ExecutionRow): string {
  if (row.result) return row.result.success ? 'Completed' : 'Failed'
  if (props.status === 'Denied' || props.status === 'Awaiting approval') return props.status
  return props.isActive ? props.status : 'Pending'
}

function statusIcon(row: ExecutionRow): string {
  if (row.result) return row.result.success ? 'lucide:circle-check' : 'lucide:circle-x'
  if (props.status === 'Denied') return 'lucide:shield-x'
  if (props.status === 'Awaiting approval') return 'lucide:shield-question'
  return props.isActive ? 'svg-spinners:ring-resize' : 'lucide:clock'
}

function tone(row: ExecutionRow): string {
  return row.internal ? 'text-purple-600 dark:text-purple-300' : 'text-accent-fg'
}
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-theme-700/50 bg-theme-800/30 shadow-sm divide-y divide-theme-700/40">
    <CollapsibleSection
      v-for="(row, index) in rows"
      :key="`${row.call?.name || row.result?.name}-${index}`"
    >
      <template #trigger="{ expanded, toggle, triggerAttrs }">
        <div class="flex min-w-0 items-center gap-3 px-3 py-2">
          <button
            v-bind="triggerAttrs"
            class="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left transition-colors hover:bg-theme-700/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            @click="toggle"
          >
            <span
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
              :class="row.internal ? 'bg-purple-500/10' : 'bg-accent-500/10'"
            >
              <ToolNamespaceIcon
                :src="row.iconUrl"
                :icon="row.icon"
                icon-class="h-4 w-4"
                class="h-5 w-5"
                :class="tone(row)"
              />
            </span>
            <span
              class="min-w-0 flex-1 truncate text-[13px] font-medium"
              :class="tone(row)"
              :title="row.name"
            >{{ row.name }}</span>
            <span class="hidden shrink-0 text-[11px] text-ink-muted sm:inline">{{ statusLabel(row) }}</span>
            <Icon
              :icon="statusIcon(row)"
              class="h-4 w-4 shrink-0"
              :class="row.result ? row.result.success ? 'text-status-success' : 'text-status-danger' : 'text-ink-muted'"
              :aria-label="statusLabel(row)"
              role="img"
            />
            <Icon
              icon="lucide:chevron-down"
              class="h-4 w-4 shrink-0 text-ink-muted transition-transform"
              :class="{ 'rotate-180': expanded }"
            />
          </button>
          <span
            v-if="!expanded && row.result?.images?.length"
            class="relative h-8 w-10 shrink-0 overflow-hidden rounded-md border border-theme-700/50"
            :aria-label="`${row.result.images.length} returned image${row.result.images.length === 1 ? '' : 's'}`"
          >
            <img
              :src="row.result.images[0]"
              alt=""
              class="h-full w-full object-cover"
            >
            <span
              v-if="row.result.images.length > 1"
              class="absolute bottom-0 right-0 bg-theme-950/85 px-1 text-[9px] text-ink-secondary"
            >+{{ row.result.images.length - 1 }}</span>
          </span>
          <FileArtifactLinks
            v-if="!expanded && row.result"
            :artifacts="fileArtifactLinks(row.result.output)"
            :limit="1"
            compact
          />
        </div>
      </template>
      <div class="space-y-2 border-t border-theme-700/30 px-3 py-3 sm:pl-14">
        <RichContent
          v-if="row.call?.arguments && row.call.arguments !== '{}'"
          :content="row.call.arguments"
          tone="muted"
          class="max-h-50 overflow-auto rounded-lg bg-theme-900/60 px-3 py-2 text-[11px]"
        />
        <RichContent
          v-if="row.result?.output"
          :content="row.result.output"
          :tone="row.result.success ? 'default' : 'error'"
          class="max-h-64 overflow-auto rounded-lg bg-theme-900/40 px-3 py-2 text-[11px]"
        />
        <div
          v-if="row.result?.images?.length"
          class="flex flex-wrap gap-2"
        >
          <button
            v-for="(src, imageIndex) in row.result.images"
            :key="imageIndex"
            class="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            :aria-label="`Enlarge image ${imageIndex + 1} from ${row.name}`"
            @click="emit('previewImage', src)"
          >
            <img
              :src="src"
              alt=""
              class="h-24 rounded-lg border border-theme-700 object-cover"
            >
          </button>
        </div>
        <p
          v-if="row.result?.error"
          class="whitespace-pre-wrap text-xs text-status-danger"
        >
          {{ row.result.error }}
        </p>
        <p
          v-if="!row.result && (!row.call?.arguments || row.call.arguments === '{}')"
          class="text-xs text-ink-muted"
        >
          {{ statusLabel(row) }}
        </p>
      </div>
    </CollapsibleSection>
    <p
      v-if="streamingText && isActive"
      class="px-3 py-2 text-xs text-ink-secondary whitespace-pre-wrap"
    >
      {{ streamingText }}
    </p>
  </div>
</template>
