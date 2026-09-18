<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { ActivityArtifact } from '../../api/types'
import ModalDialog from './ModalDialog.vue'

const props = defineProps<{
  artifact: ActivityArtifact | null
  createdAt?: number
  agentName?: string | null
  conversationTitle?: string | null
  conversationId?: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const extension = computed(() => (props.artifact?.ext || '').replace(/^\./, '').toLowerCase())
const textExtensions = new Set(['txt', 'md', 'csv', 'tsv', 'json'])
const isTextDocument = computed(() => textExtensions.has(extension.value))
const canPreviewDocument = computed(() => extension.value === 'pdf' || isTextDocument.value)

// Text documents are rendered inline (themed) instead of in an iframe, whose
// UA styling follows the app's color-scheme and can render white-on-white.
const textContent = ref('')
const textLoadError = ref(false)

watch(() => props.artifact, async (artifact) => {
  textContent.value = ''
  textLoadError.value = false
  if (!artifact || !isTextDocument.value) return
  try {
    const response = await fetch(artifact.href)
    if (!response.ok) throw new Error(String(response.status))
    textContent.value = await response.text()
  } catch {
    textLoadError.value = true
  }
}, { immediate: true })

const typeLabel = computed(() => {
  if (!props.artifact) return 'Library item'
  if (props.artifact.kind === 'file') return extension.value ? `${extension.value.toUpperCase()} document` : 'Document'
  return props.artifact.kind.charAt(0).toUpperCase() + props.artifact.kind.slice(1)
})

const icon = computed(() => {
  if (props.artifact?.kind === 'image') return 'lucide:image'
  if (props.artifact?.kind === 'video') return 'lucide:film'
  if (props.artifact?.kind === 'audio') return 'lucide:audio-lines'
  return 'lucide:file-text'
})

const formattedDate = computed(() => props.createdAt
  ? new Date(props.createdAt).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  : null)
</script>

<template>
  <ModalDialog
    :show="Boolean(artifact)"
    :title="artifact?.label || 'Library item preview'"
    :icon="icon"
    max-width="max-w-5xl"
    max-height="max-h-[94vh]"
    @close="emit('close')"
  >
    <template v-if="artifact">
      <div class="flex min-h-80 items-center justify-center overflow-hidden rounded-xl border border-theme-700/70 bg-theme-950/70">
        <img
          v-if="artifact.kind === 'image'"
          :src="artifact.href"
          :alt="artifact.label"
          class="max-h-[62vh] w-full object-contain"
        >

        <video
          v-else-if="artifact.kind === 'video'"
          :src="artifact.href"
          controls
          playsinline
          class="max-h-[62vh] w-full bg-black object-contain"
        />

        <div
          v-else-if="artifact.kind === 'audio'"
          class="flex w-full max-w-2xl flex-col items-center gap-6 px-6 py-14"
        >
          <div class="flex h-24 w-24 items-center justify-center rounded-3xl bg-accent-500/15 text-accent-300 ring-1 ring-accent-400/20">
            <Icon
              icon="lucide:audio-lines"
              class="h-11 w-11"
            />
          </div>
          <audio
            :src="artifact.href"
            controls
            class="w-full"
          />
        </div>

        <pre
          v-else-if="isTextDocument && !textLoadError"
          class="library-text-preview h-[62vh] w-full overflow-auto whitespace-pre-wrap wrap-break-word p-5 font-mono text-sm leading-relaxed text-theme-200"
        >{{ textContent || ' ' }}</pre>

        <div
          v-else-if="isTextDocument && textLoadError"
          class="flex h-[62vh] w-full flex-col items-center justify-center gap-2 text-center"
        >
          <Icon
            icon="lucide:triangle-alert"
            class="h-8 w-8 text-theme-400"
          />
          <p class="text-sm text-theme-300">
            Could not load the document preview.
          </p>
        </div>

        <!-- No sandbox: Chromium's built-in PDF viewer is an internal extension,
             which sandboxed frames block (ERR_BLOCKED_BY_CLIENT). The source is
             our own /api/files route with an extension allowlist. -->
        <iframe
          v-else-if="canPreviewDocument"
          :src="artifact.href"
          :title="`Preview of ${artifact.label}`"
          class="h-[62vh] w-full border-0 bg-white"
        />

        <div
          v-else
          class="flex max-w-md flex-col items-center px-8 py-16 text-center"
        >
          <div class="mb-5 flex h-24 w-24 items-center justify-center rounded-3xl bg-theme-800 text-theme-400 ring-1 ring-theme-700">
            <Icon
              :icon="icon"
              class="h-11 w-11"
            />
          </div>
          <p class="text-base font-medium text-theme-200">
            Preview isn't available for this file type
          </p>
          <p class="mt-2 text-sm leading-6 text-theme-500">
            Download the file to open it with an app on your device.
          </p>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-theme-500">
        <span class="rounded-md bg-theme-800 px-2 py-1 font-semibold text-theme-300">{{ typeLabel }}</span>
        <span v-if="agentName">Created by {{ agentName }}</span>
        <span v-if="agentName && formattedDate">·</span>
        <span v-if="formattedDate">{{ formattedDate }}</span>
        <span
          v-if="conversationTitle"
          class="min-w-0 truncate"
        >· {{ conversationTitle }}</span>
      </div>
    </template>

    <template #actions>
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          class="rounded-xl bg-theme-800 px-4 py-2.5 text-sm font-medium text-theme-300 transition-colors hover:bg-theme-700 hover:text-theme-100"
          @click="emit('close')"
        >
          Close
        </button>
        <a
          v-if="artifact"
          :href="artifact.href"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center justify-center gap-2 rounded-xl border border-theme-700 px-4 py-2.5 text-sm font-medium text-theme-300 transition-colors hover:border-theme-600 hover:bg-theme-800 hover:text-theme-100"
        >
          <Icon
            icon="lucide:external-link"
            class="h-4 w-4"
          />
          Open original
        </a>
        <a
          v-if="artifact"
          :href="artifact.href"
          :download="artifact.label"
          class="inline-flex items-center justify-center gap-2 rounded-xl bg-accent-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-500"
        >
          <Icon
            icon="lucide:download"
            class="h-4 w-4"
          />
          Download
        </a>
        <RouterLink
          v-if="conversationId"
          :to="`/chat/${encodeURIComponent(conversationId)}`"
          class="inline-flex items-center justify-center gap-2 rounded-xl border border-accent-500/40 bg-accent-500/10 px-4 py-2.5 text-sm font-semibold text-accent-200 transition-colors hover:border-accent-400/60 hover:bg-accent-500/20"
          @click="emit('close')"
        >
          <Icon
            icon="lucide:message-square"
            class="h-4 w-4"
          />
          Go to chat
        </RouterLink>
      </div>
    </template>
  </ModalDialog>
</template>
