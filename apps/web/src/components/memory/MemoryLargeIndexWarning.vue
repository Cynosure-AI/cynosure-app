<script setup lang="ts">
import type { MemoryFileStatus } from "../../api/types";
import ModalDialog from "../shared/ModalDialog.vue";

defineProps<{
  show: boolean;
  files: MemoryFileStatus[];
  threshold: number;
}>();

defineEmits<{
  confirm: [];
  cancel: [];
}>();

function estimatedChunks(file: MemoryFileStatus): number {
  return file.estimatedChunkCount ?? file.chunkCount ?? 0;
}
</script>

<template>
  <ModalDialog
    :show="show"
    title="Index a large document?"
    icon="lucide:triangle-alert"
    icon-color="amber"
    @close="$emit('cancel')"
  >
    <div class="space-y-3 text-sm leading-relaxed text-theme-400">
      <p>
        {{ files.length === 1
          ? `${files[0]?.fileName} is estimated to produce ${estimatedChunks(files[0]!)} chunks.`
          : `${files.length} selected files are each estimated to produce more than ${threshold} chunks.` }}
      </p>
      <p>Very large documents can dominate search results simply because they contribute so many chunks. They also take longer to embed and may increase embedding costs and storage use.</p>
      <p class="text-theme-300">
        You can continue anyway if this is intentional.
      </p>
    </div>
    <template #actions>
      <button
        type="button"
        class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500"
        @click="$emit('confirm')"
      >
        Index anyway
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm text-theme-400 transition-colors hover:text-theme-200"
        @click="$emit('cancel')"
      >
        Cancel
      </button>
    </template>
  </ModalDialog>
</template>
