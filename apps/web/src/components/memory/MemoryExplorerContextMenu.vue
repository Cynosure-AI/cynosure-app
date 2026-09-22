<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { MemoryFileStatus, MemoryFolder } from "../../api/types";
import type { ExplorerContextMenu } from "./memory-file-explorer-types";

defineProps<{
  menu: ExplorerContextMenu | null;
  spaceCount: number;
  supportsAnalysis: (file: MemoryFileStatus) => boolean;
}>();

const emit = defineEmits<{
  close: [];
  openFolder: [folder: MemoryFolder];
  createFolder: [folder: MemoryFolder];
  editFolder: [folder: MemoryFolder];
  toggleAutoMemoryExclusion: [folder: MemoryFolder];
  deleteFolder: [folder: MemoryFolder];
  openDocument: [file: MemoryFileStatus];
  moveDocument: [file: MemoryFileStatus];
  indexDocument: [file: MemoryFileStatus];
  researchDocument: [file: MemoryFileStatus];
  forgetDocument: [file: MemoryFileStatus];
  removeDocument: [file: MemoryFileStatus];
}>();

</script>

<template>
  <Teleport to="body">
    <div
      v-if="menu"
      data-memory-context-menu
      data-testid="memory-explorer-context-menu"
      class="fixed z-[80] w-60 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-2xl shadow-black/50"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <template v-if="menu.kind === 'folder' && menu.folder">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          role="menuitem"
          @click="emit('openFolder', menu.folder); emit('close')"
        >
          <Icon
            icon="lucide:folder-open"
            class="h-3.5 w-3.5 text-amber-400"
          /> Open
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          role="menuitem"
          @click="emit('createFolder', menu.folder); emit('close')"
        >
          <Icon
            icon="lucide:folder-plus"
            class="h-3.5 w-3.5 text-accent-400"
          /> Add subfolder
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          role="menuitem"
          @click="emit('editFolder', menu.folder); emit('close')"
        >
          <Icon
            icon="lucide:settings-2"
            class="h-3.5 w-3.5"
          /> Folder settings
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          role="menuitem"
          @click="emit('toggleAutoMemoryExclusion', menu.folder); emit('close')"
        >
          <Icon
            :icon="menu.folder.autoMemoryExcluded ? 'lucide:folder-check' : 'lucide:folder-x'"
            class="h-3.5 w-3.5"
            :class="menu.folder.autoMemoryExcluded ? 'text-emerald-400' : 'text-orange-400'"
          />
          {{ menu.folder.autoMemoryExcluded ? 'Include in Auto Memory Router' : 'Exclude from Auto Memory Router' }}
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-left text-xs text-red-300 hover:bg-red-500/10"
          role="menuitem"
          @click="emit('deleteFolder', menu.folder); emit('close')"
        >
          <Icon
            icon="lucide:trash-2"
            class="h-3.5 w-3.5"
          /> Delete folder
        </button>
      </template>
      <template v-else-if="menu.kind === 'document' && menu.file">
        <div class="border-b border-theme-800 px-3 py-2 text-[11px] text-theme-500">
          {{ menu.file.fileName }}
        </div>
        <button
          v-if="menu.file.textDirect"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          role="menuitem"
          @click="emit('openDocument', menu.file); emit('close')"
        >
          <Icon
            icon="lucide:file-pen-line"
            class="h-3.5 w-3.5"
          /> Open
        </button>
        <button
          v-if="spaceCount > 1"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          role="menuitem"
          @click="emit('moveDocument', menu.file)"
        >
          <Icon
            icon="lucide:folder-input"
            class="h-3.5 w-3.5 text-accent-400"
          /> Move
        </button>
        <button
          v-if="menu.file.supported && (menu.file.status === 'needs_reindex' || menu.file.status === 'not_indexed')"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-orange-300 hover:bg-orange-500/10"
          role="menuitem"
          @click="emit('indexDocument', menu.file); emit('close')"
        >
          <Icon
            icon="lucide:search-check"
            class="h-3.5 w-3.5"
          /> Index files
        </button>
        <button
          v-if="menu.file.supported && supportsAnalysis(menu.file)"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-emerald-300 hover:bg-emerald-500/10"
          role="menuitem"
          @click="emit('researchDocument', menu.file); emit('close')"
        >
          <Icon
            icon="lucide:network"
            class="h-3.5 w-3.5"
          /> Deep Research
        </button>
        <button
          v-if="menu.file.supported && (menu.file.status !== 'not_indexed' || menu.file.deepResearched)"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-orange-300 hover:bg-orange-500/10"
          role="menuitem"
          @click="emit('forgetDocument', menu.file); emit('close')"
        >
          <Icon
            icon="lucide:brain-circuit"
            class="h-3.5 w-3.5"
          /> Drop Index
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-left text-xs text-red-300 hover:bg-red-500/10"
          role="menuitem"
          @click="emit('removeDocument', menu.file); emit('close')"
        >
          <Icon
            icon="lucide:trash-2"
            class="h-3.5 w-3.5"
          /> Remove
        </button>
      </template>
    </div>
  </Teleport>
</template>
