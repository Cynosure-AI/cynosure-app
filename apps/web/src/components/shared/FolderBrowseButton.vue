<script setup lang="ts">
import { ref } from 'vue'
import { Icon } from '@iconify/vue'
import FolderPickerDialog from './FolderPickerDialog.vue'

defineProps<{
  /** Folder the in-app picker opens at. */
  initialPath?: string
}>()

const emit = defineEmits<{
  select: [path: string]
}>()

const electron = (window as unknown as { electron?: { chooseFileAccessDirectory?: () => Promise<string | null> } }).electron
const pickerOpen = ref(false)

/** Desktop builds use the native dialog; the browser falls back to the server-backed picker. */
async function browse(): Promise<void> {
  if (electron?.chooseFileAccessDirectory) {
    const selected = await electron.chooseFileAccessDirectory()
    if (selected) emit('select', selected)
    return
  }
  pickerOpen.value = true
}
</script>

<template>
  <button
    type="button"
    class="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-theme-700 px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
    @click="browse"
  >
    <Icon
      icon="lucide:folder-open"
      class="h-4 w-4"
    />
    Browse
  </button>
  <FolderPickerDialog
    :show="pickerOpen"
    :initial-path="initialPath"
    @close="pickerOpen = false"
    @select="emit('select', $event)"
  />
</template>
