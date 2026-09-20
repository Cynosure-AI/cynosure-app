<script setup lang="ts">
import { nextTick, ref } from "vue";
import { Icon } from "@iconify/vue";
import type { MemoryFolder } from "../../api/types";
import MemoryDocumentList from "./MemoryDocumentList.vue";

const props = defineProps<{
  spaces: MemoryFolder[];
  spacesLoading: boolean;
  selectedFolderId: string | null;
  selectedFolder: MemoryFolder | null;
  activeSidebarView?: "folder" | "recent" | "trash";
  focusFile?: string;
}>();

const emit = defineEmits<{
  "update:selectedFolderId": [value: string | null];
  "create-folder": [parent?: MemoryFolder];
  "edit-folder": [space: MemoryFolder];
  "delete-folder": [space: MemoryFolder];
  "toggle-auto-memory-exclusion": [space: MemoryFolder];
  "select-sidebar-view": [view: "folder" | "recent" | "trash"];
  "refresh-spaces": [];
  "folder-navigation": [];
}>();

const docList = ref<InstanceType<typeof MemoryDocumentList> | null>(null);
const dragCounter = ref(0);

function selectView(view: "folder" | "recent" | "trash"): void {
  emit("select-sidebar-view", view);
}

function navigateToFolder(folderId: string): void {
  emit("update:selectedFolderId", folderId);
  emit("select-sidebar-view", "folder");
  emit("folder-navigation");
}

async function openGlobalDocument(folderId: string, fileName: string): Promise<void> {
  if (folderId !== props.selectedFolderId) emit("update:selectedFolderId", folderId);
  emit("select-sidebar-view", "folder");
  await nextTick();
  docList.value?.openDocument(fileName);
}

function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

function onDragEnter(event: DragEvent): void {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragCounter.value++;
}

function onDragLeave(event: DragEvent): void {
  if (!isFileDrag(event)) return;
  dragCounter.value = Math.max(0, dragCounter.value - 1);
}

function onDragOver(event: DragEvent): void {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

async function onFileDrop(event: DragEvent): Promise<void> {
  if (!isFileDrag(event) || !props.selectedFolderId) return;
  event.preventDefault();
  dragCounter.value = 0;
  const files = event.dataTransfer?.files;
  if (files?.length) await docList.value?.ingestFiles(Array.from(files));
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-8">
    <nav
      class="mb-4 flex items-center gap-1 overflow-x-auto rounded-xl border border-theme-800 bg-theme-950/45 p-1"
      aria-label="Memory views"
    >
      <button
        type="button"
        data-testid="memory-explorer-view"
        class="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
        :class="(activeSidebarView ?? 'folder') === 'folder' ? 'bg-theme-800 text-theme-100' : 'text-theme-400 hover:text-theme-200'"
        @click="selectView('folder')"
      >
        <Icon
          icon="lucide:folder-tree"
          class="h-4 w-4 text-amber-400"
        />
        Explorer
      </button>
      <button
        type="button"
        data-testid="memory-recent-view"
        class="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
        :class="activeSidebarView === 'recent' ? 'bg-theme-800 text-theme-100' : 'text-theme-400 hover:text-theme-200'"
        @click="selectView('recent')"
      >
        <Icon
          icon="lucide:history"
          class="h-4 w-4 text-accent-400"
        />
        Recent
      </button>
      <button
        type="button"
        data-testid="memory-trash-view"
        class="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
        :class="activeSidebarView === 'trash' ? 'bg-red-500/10 text-red-200' : 'text-theme-400 hover:text-red-300'"
        @click="selectView('trash')"
      >
        <Icon
          icon="lucide:trash-2"
          class="h-4 w-4"
        />
        Trash
      </button>
      <button
        type="button"
        class="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-theme-500 transition hover:bg-theme-800 hover:text-theme-200"
        title="Refresh memory folders"
        aria-label="Refresh memory folders"
        @click="emit('refresh-spaces')"
      >
        <Icon
          icon="lucide:refresh-cw"
          class="h-4 w-4"
          :class="{ 'animate-spin': spacesLoading }"
        />
      </button>
    </nav>

    <div
      v-if="(activeSidebarView ?? 'folder') === 'folder' && selectedFolderId"
      data-testid="memory-document-drop-zone"
      class="relative min-w-0"
      @dragenter="onDragEnter"
      @dragleave="onDragLeave"
      @dragover="onDragOver"
      @drop="onFileDrop"
    >
      <div
        v-if="dragCounter > 0"
        class="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-accent-500/40 bg-theme-950/90"
      >
        <div class="text-center">
          <Icon
            icon="lucide:upload-cloud"
            class="mx-auto mb-2 h-12 w-12 text-accent-400"
          />
          <p class="font-medium text-accent-300">
            Drop files into {{ selectedFolder?.name || "selected folder" }}
          </p>
        </div>
      </div>

      <MemoryDocumentList
        ref="docList"
        :folder-id="selectedFolderId"
        :spaces="spaces"
        :focus-file="focusFile"
        @edit-space="selectedFolder && emit('edit-folder', selectedFolder)"
        @delete-space="selectedFolder && emit('delete-folder', selectedFolder)"
        @create-folder="emit('create-folder', $event)"
        @edit-folder="emit('edit-folder', $event)"
        @delete-folder="emit('delete-folder', $event)"
        @toggle-auto-memory-exclusion="emit('toggle-auto-memory-exclusion', $event)"
        @spaces-changed="emit('refresh-spaces')"
        @navigate-folder="navigateToFolder"
        @open-global-document="openGlobalDocument"
      />
    </div>

    <div
      v-else-if="activeSidebarView === 'recent' || activeSidebarView === 'trash'"
      data-testid="memory-special-content"
      class="min-w-0"
    >
      <slot :name="activeSidebarView" />
    </div>
  </div>
</template>
