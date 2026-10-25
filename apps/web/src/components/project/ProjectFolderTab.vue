<script setup lang="ts">
import { computed, ref } from 'vue'
import { Icon } from '@iconify/vue'
import type { ProjectDto } from '@shared/types'
import { api } from '../../api/client'
import type { ProjectFileContent, ProjectFileEntry } from '../../api/types'
import BaseCard from '../shared/BaseCard.vue'
import ModalDialog from '../shared/ModalDialog.vue'
import RichContent from '../shared/RichContent.vue'
import ProjectFileBrowser from './ProjectFileBrowser.vue'

/** Browse the files in the project directory, the same folder agents work in. */
const props = defineProps<{ project: ProjectDto }>()

/** Mirrors the server cap; larger files can't be read for a preview. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

const previewPath = ref<string | null>(null)
const preview = ref<ProjectFileContent | null>(null)
const previewError = ref('')
let previewSequence = 0

/** Parseable documents come back as data URLs and can't be shown as text. */
const previewText = computed(() => preview.value?.kind === 'file' && !preview.value.content.startsWith('data:') ? preview.value.content : null)
const previewIsMarkdown = computed(() => /\.(md|markdown|mdx)$/i.test(previewPath.value ?? ''))

function unavailableReason(entry: ProjectFileEntry): string | null {
  return (entry.size ?? 0) > MAX_FILE_BYTES ? 'Over 20 MB' : null
}

async function openFile(entry: ProjectFileEntry): Promise<void> {
  const sequence = ++previewSequence
  previewPath.value = entry.path
  preview.value = null
  previewError.value = ''
  try {
    const content = await api.projects.readFile(props.project.id, entry.path)
    if (sequence === previewSequence) preview.value = content
  } catch (err) {
    if (sequence === previewSequence) previewError.value = err instanceof Error ? err.message : 'Could not read the file'
  }
}

function closePreview(): void {
  previewSequence++
  previewPath.value = null
  preview.value = null
}
</script>

<template>
  <BaseCard class="p-5">
    <div class="mb-4 flex min-w-0 items-start gap-3">
      <Icon
        icon="lucide:folder-code"
        class="mt-0.5 h-5 w-5 shrink-0 text-ink-muted"
        aria-hidden="true"
      />
      <div class="min-w-0">
        <h2 class="text-base font-semibold text-theme-100">
          Project folder
        </h2>
        <p class="mt-0.5 font-mono text-xs text-ink-muted [overflow-wrap:anywhere]">
          {{ project.rootPath }}
        </p>
      </div>
    </div>
    <ProjectFileBrowser
      :project-id="project.id"
      :project-name="project.name"
      :root-path="project.rootPath"
      default-layout="grid"
      :unavailable-reason="unavailableReason"
      @file="openFile"
    />
  </BaseCard>

  <ModalDialog
    :show="Boolean(previewPath)"
    :title="previewPath ?? ''"
    icon="lucide:file"
    max-width="max-w-4xl"
    max-height="max-h-[90vh]"
    @close="closePreview"
  >
    <p
      v-if="previewError"
      role="alert"
      class="rounded-lg bg-status-danger/10 px-3 py-2 text-sm text-status-danger"
    >
      {{ previewError }}
    </p>
    <div
      v-else-if="!preview"
      class="flex min-h-40 items-center justify-center text-sm text-ink-muted"
    >
      <Icon
        icon="lucide:loader-circle"
        class="mr-2 h-4 w-4 animate-spin"
      /> Loading…
    </div>
    <img
      v-else-if="preview.kind === 'image'"
      :src="preview.content"
      :alt="preview.name"
      class="mx-auto max-h-[70vh] max-w-full rounded-lg object-contain"
    >
    <audio
      v-else-if="preview.kind === 'audio'"
      :src="preview.content"
      controls
      class="w-full"
    />
    <RichContent
      v-else-if="previewText !== null && previewIsMarkdown"
      :content="previewText"
      class="max-h-[70vh] rounded-lg border border-theme-800 bg-theme-900 p-4 text-sm"
    />
    <pre
      v-else-if="previewText !== null"
      class="max-h-[70vh] overflow-auto whitespace-pre rounded-lg border border-theme-800 bg-theme-900 p-3 font-mono text-xs leading-relaxed text-theme-200"
    >{{ previewText }}</pre>
    <p
      v-else
      class="py-8 text-center text-sm text-ink-muted"
    >
      No preview for this file type. Attach it to a chat to have an agent read it.
    </p>
  </ModalDialog>
</template>
