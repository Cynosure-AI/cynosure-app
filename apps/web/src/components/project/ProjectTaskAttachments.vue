<script setup lang="ts">
import { ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { ProjectTaskAttachmentDto } from '@shared/types'
import DocumentTypeArt from '../shared/DocumentTypeArt.vue'
import { api } from '../../api/client'
import { formatBytes } from '../../utils/format-bytes'

const props = defineProps<{ projectId: string; taskId: string }>()

/** Same cap the server and the chat composer apply. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

const attachments = ref<ProjectTaskAttachmentDto[]>([])
const uploading = ref(0)
const error = ref('')
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function load(): Promise<void> {
  try {
    attachments.value = await api.projects.listTaskAttachments(props.projectId, props.taskId)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

async function upload(files: File[]): Promise<void> {
  error.value = ''
  const tooLarge = files.filter((file) => file.size > MAX_FILE_BYTES)
  if (tooLarge.length) error.value = `Files larger than 20 MB cannot be attached: ${tooLarge.map((file) => file.name).join(', ')}`
  await Promise.all(files.filter((file) => file.size <= MAX_FILE_BYTES).map(async (file) => {
    uploading.value++
    try {
      const attachment = await api.projects.addTaskAttachment(props.projectId, props.taskId, { name: file.name, content: await readAsDataUrl(file) })
      attachments.value = [...attachments.value, attachment]
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      uploading.value--
    }
  }))
}

function onFileSelect(event: Event): void {
  const input = event.target as HTMLInputElement
  void upload(Array.from(input.files ?? []))
  input.value = ''
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  void upload(Array.from(event.dataTransfer?.files ?? []))
}

function onPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  void upload(files)
}

async function remove(attachment: ProjectTaskAttachmentDto): Promise<void> {
  error.value = ''
  try {
    await api.projects.removeTaskAttachment(props.projectId, props.taskId, attachment.id)
    attachments.value = attachments.value.filter((item) => item.id !== attachment.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function href(attachment: ProjectTaskAttachmentDto): string {
  return api.projects.taskAttachmentHref(props.projectId, props.taskId, attachment.id)
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** SVG is downloaded rather than shown, so it can't preview as an image. */
function isImage(attachment: ProjectTaskAttachmentDto): boolean {
  return attachment.mimeType.startsWith('image/') && attachment.mimeType !== 'image/svg+xml'
}

watch(() => [props.projectId, props.taskId], () => {
  attachments.value = []
  error.value = ''
  void load()
}, { immediate: true })
</script>

<template>
  <section
    class="min-w-0 rounded-xl border p-3 transition-colors"
    :class="dragging ? 'border-dashed border-accent-500/60 bg-accent-500/5' : 'border-theme-800 bg-theme-950/30'"
    aria-label="Attachments"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
    @paste="onPaste"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 class="flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
        <Icon
          icon="lucide:paperclip"
          class="h-3.5 w-3.5"
        />
        Attachments
        <span
          v-if="attachments.length"
          class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] text-ink-muted"
        >{{ attachments.length }}</span>
      </h3>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 px-2.5 py-1 text-xs text-theme-300 hover:bg-theme-800 disabled:opacity-60"
        :disabled="uploading > 0"
        @click="fileInput?.click()"
      >
        <Icon
          :icon="uploading ? 'lucide:loader-2' : 'lucide:plus'"
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': uploading }"
        />
        {{ uploading ? 'Uploading…' : 'Add files' }}
      </button>
      <input
        ref="fileInput"
        type="file"
        multiple
        class="hidden"
        @change="onFileSelect"
      >
    </div>

    <p
      v-if="!attachments.length && !uploading"
      class="rounded-lg border border-dashed border-theme-700 px-3 py-5 text-center text-xs leading-relaxed text-ink-faint"
    >
      Drop files or screenshots here, or paste them.
    </p>

    <ul
      v-else
      class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,6rem),1fr))] gap-2"
    >
      <li
        v-for="attachment in attachments"
        :key="attachment.id"
        class="group relative min-w-0 overflow-hidden rounded-lg border border-theme-800 bg-theme-950/45 transition hover:border-theme-600"
      >
        <a
          :href="href(attachment)"
          target="_blank"
          rel="noopener"
          class="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
          :title="`Open ${attachment.name}`"
        >
          <div class="relative aspect-4/3 w-full overflow-hidden bg-theme-950">
            <img
              v-if="isImage(attachment)"
              :src="href(attachment)"
              :alt="attachment.name"
              loading="lazy"
              class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]"
            >
            <DocumentTypeArt
              v-else
              :ext="extension(attachment.name)"
              compact
              class="transition duration-300 group-hover:scale-[1.025]"
            />
            <span
              v-if="extension(attachment.name)"
              class="absolute left-1.5 top-1.5 rounded-md border border-white/10 bg-black/55 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white/85 backdrop-blur-sm"
            >{{ extension(attachment.name) }}</span>
          </div>
          <div class="px-2 py-1.5">
            <p class="truncate text-xs text-theme-200">{{ attachment.name }}</p>
            <p class="text-[10px] text-ink-muted">{{ formatBytes(attachment.sizeBytes) }}</p>
          </div>
        </a>
        <button
          type="button"
          class="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white/85 backdrop-blur-sm transition hover:bg-status-danger hover:text-white focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          :aria-label="`Remove ${attachment.name}`"
          title="Remove attachment"
          @click="remove(attachment)"
        >
          <Icon
            icon="lucide:x"
            class="h-3.5 w-3.5"
          />
        </button>
      </li>
    </ul>

    <p
      v-if="error"
      class="mt-2 text-xs text-status-danger"
    >
      {{ error }}
    </p>
  </section>
</template>
