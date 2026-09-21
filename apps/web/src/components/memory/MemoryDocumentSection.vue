<script setup lang="ts">
import { nextTick, ref } from "vue";
import { Icon } from "@iconify/vue";
import type { MemoryFolder } from "../../api/types";
import MemoryFileExplorer from "./MemoryFileExplorer.vue";
import MemoryVirtualExplorer from "./MemoryVirtualExplorer.vue";

const props = defineProps<{
  spaces: MemoryFolder[];
  spacesLoading: boolean;
  selectedFolderId: string | null;
  selectedFolder: MemoryFolder | null;
  activeView?: "folder" | "recent" | "trash";
  focusFile?: string;
}>();

const emit = defineEmits<{
  "update:selectedFolderId": [value: string | null];
  "create-folder": [parent?: MemoryFolder];
  "edit-folder": [space: MemoryFolder];
  "delete-folder": [space: MemoryFolder];
  "toggle-auto-memory-exclusion": [space: MemoryFolder];
  "select-view": [view: "folder" | "recent" | "trash"];
  "refresh-spaces": [];
  "folder-navigation": [];
}>();

const fileExplorer = ref<InstanceType<typeof MemoryFileExplorer> | null>(null);
const dragCounter = ref(0);

function navigateToFolder(folderId: string): void {
  emit("update:selectedFolderId", folderId);
  emit("select-view", "folder");
  emit("folder-navigation");
}

function navigateHome(): void {
  const root = props.spaces.find(space => space.isUncategorized) || props.spaces[0];
  if (root) emit("update:selectedFolderId", root.id);
  emit("select-view", "folder");
  emit("folder-navigation");
}

async function openGlobalDocument(folderId: string, fileName: string): Promise<void> {
  if (folderId !== props.selectedFolderId) emit("update:selectedFolderId", folderId);
  emit("select-view", "folder");
  await nextTick();
  fileExplorer.value?.openDocument(fileName);
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
  if (files?.length) await fileExplorer.value?.ingestFiles(Array.from(files));
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-8">
    <div
      v-if="(activeView ?? 'folder') === 'folder' && selectedFolderId"
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

      <MemoryFileExplorer
        ref="fileExplorer"
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

    <MemoryVirtualExplorer
      v-else-if="activeView === 'recent' || activeView === 'trash'"
      data-testid="memory-special-content"
      :mode="activeView"
      :spaces="spaces"
      @home="navigateHome"
      @restored="emit('refresh-spaces')"
    />
  </div>
</template>
