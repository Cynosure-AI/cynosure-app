<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { MemoryFolder } from "../../api/types";
import ModalDialog from "../shared/ModalDialog.vue";

defineProps<{
  show: boolean;
  sourceFolderId: string;
  selectedCount: number;
  spaces: MemoryFolder[];
  moving: boolean;
}>();

defineEmits<{
  close: [];
  move: [targetFolderId: string];
}>();
</script>

<template>
  <ModalDialog
    :show="show"
    :title="`Move ${selectedCount} item${selectedCount !== 1 ? 's' : ''}`"
    icon="lucide:folder-input"
    max-width="max-w-2xl"
    max-height="max-h-[85vh]"
    @close="$emit('close')"
  >
    <p class="mb-4 text-sm text-ink-muted">
      Select the destination memory folder.
    </p>
    <div class="grid max-h-[55vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
      <button
        v-for="space in spaces.filter((item) => item.id !== sourceFolderId)"
        :key="space.id"
        :disabled="moving"
        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-theme-800 hover:border-accent-500/50 hover:bg-accent-500/5 transition-colors text-left disabled:opacity-50"
        @click="$emit('move', space.id)"
      >
        <Icon
          icon="lucide:folder"
          class="w-4 h-4 text-ink-secondary shrink-0"
        />
        <div class="flex-1 min-w-0">
          <div class="text-sm text-theme-200 truncate">
            {{ space.name }}
          </div>
          <div class="text-xs text-ink-muted">
            {{ space.fileCount }} file{{ space.fileCount !== 1 ? "s" : "" }}
          </div>
        </div>
        <Icon
          :icon="moving ? 'lucide:loader-2' : 'lucide:chevron-right'"
          class="w-4 h-4 text-ink-faint shrink-0"
          :class="{ 'animate-spin': moving }"
        />
      </button>
    </div>
    <template #actions>
      <button
        class="w-full rounded-xl bg-theme-800 px-4 py-3 text-center text-sm font-medium text-theme-300 transition-colors hover:bg-theme-700"
        @click="$emit('close')"
      >
        Cancel
      </button>
    </template>
  </ModalDialog>
</template>
