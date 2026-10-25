<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../../../api/client'
import type { ProjectFileContent, ProjectFileEntry } from '../../../api/types'
import ModalDialog from '../../shared/ModalDialog.vue'
import ProjectFileBrowser from '../../project/ProjectFileBrowser.vue'

/** Mirrors the server cap so oversized files can't be picked. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

const props = defineProps<{
  show: boolean
  projectId: string | null
  projectName?: string
  /** Project-relative paths already in the draft. */
  alreadySelectedPaths?: string[]
}>()

const emit = defineEmits<{
  close: []
  add: [files: ProjectFileContent[]]
}>()

const selected = ref(new Map<string, ProjectFileEntry>())
const selectedPaths = computed(() => new Set(selected.value.keys()))
const adding = ref(false)
const error = ref('')

const unavailablePaths = computed(() => new Set(props.alreadySelectedPaths || []))

function unavailableReason(entry: ProjectFileEntry): string | null {
  if (unavailablePaths.value.has(entry.path)) return 'Already attached'
  return (entry.size ?? 0) > MAX_FILE_BYTES ? 'Over 20 MB' : null
}

function toggle(entry: ProjectFileEntry): void {
  const next = new Map(selected.value)
  if (next.has(entry.path)) next.delete(entry.path)
  else next.set(entry.path, entry)
  selected.value = next
}

async function addSelected(): Promise<void> {
  if (!props.projectId || !selected.value.size || adding.value) return
  adding.value = true
  error.value = ''
  const projectId = props.projectId
  try {
    const paths = [...selected.value.keys()]
    const results = await Promise.allSettled(paths.map(path => api.projects.readFile(projectId, path)))
    const files = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [`${paths[index]}: ${result.reason instanceof Error ? result.reason.message : 'Could not read the file'}`]
      : [])
    if (files.length) emit('add', files)
    if (!failures.length) {
      emit('close')
      return
    }
    // Keep only the files that failed so the user can see what was skipped.
    selected.value = new Map([...selected.value].filter(([path]) => !files.some(file => file.name === path)))
    error.value = failures.join('\n')
  } finally {
    adding.value = false
  }
}

watch(() => props.show, (show) => {
  if (!show) return
  selected.value = new Map()
  error.value = ''
})
</script>

<template>
  <ModalDialog
    :show="show"
    :title="projectName ? `Attach From ${projectName}` : 'Attach From Project'"
    icon="lucide:folder-open"
    max-width="max-w-2xl"
    max-height="max-h-[82vh]"
    @close="emit('close')"
  >
    <div class="flex h-[min(62vh,600px)] min-h-80 flex-col gap-3">
      <div
        v-if="error"
        role="alert"
        class="shrink-0 whitespace-pre-line rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
      >
        {{ error }}
      </div>
      <ProjectFileBrowser
        v-if="projectId"
        class="min-h-0 flex-1"
        :project-id="projectId"
        :project-name="projectName"
        :selected-paths="selectedPaths"
        :unavailable-reason="unavailableReason"
        @file="toggle"
      />
    </div>

    <template #actions>
      <div class="flex items-center justify-end gap-2">
        <span
          v-if="selected.size"
          class="mr-auto text-xs text-ink-muted"
        >{{ selected.size }} selected</span>
        <button
          type="button"
          class="rounded-lg border border-theme-700 px-4 py-2 text-sm text-theme-300 hover:bg-theme-800"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!selected.size || adding"
          class="rounded-lg accent-action bg-accent-600 px-4 py-2 text-sm font-medium text-accent-on disabled:opacity-50"
          @click="addSelected"
        >
          {{ adding ? 'Attaching…' : selected.size > 1 ? `Attach ${selected.size} files` : 'Attach' }}
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
