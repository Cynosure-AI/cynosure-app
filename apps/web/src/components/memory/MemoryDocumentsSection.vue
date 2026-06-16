<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Icon } from "@iconify/vue";
import type { MemorySpace } from "../../api/types";
import MemoryDocumentList from "./MemoryDocumentList.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";
const COLLAPSED_KEY = "cy-memory-folder-collapsed";

const props = defineProps<{
  spaces: MemorySpace[];
  spacesLoading: boolean;
  selectedSpaceId: string | null;
  selectedSpace: MemorySpace | null;
}>();

const emit = defineEmits<{
  "update:selectedSpaceId": [value: string | null];
  "create-folder": [parent?: MemorySpace];
  "edit-folder": [space: MemorySpace];
  "delete-folder": [space: MemorySpace];
  "refresh-spaces": [];
}>();

const docList = ref<InstanceType<typeof MemoryDocumentList> | null>(null);
const collapsedFolders = ref<Set<string>>(readCollapsedFolders());
const dragCounter = ref(0);
const dropTargetSpaceId = ref<string | null>(null);

const sortedSpaces = computed(() =>
  [...props.spaces].sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return (a.relativePath || "").localeCompare(b.relativePath || "");
  }),
);

const visibleSpaces = computed(() =>
  sortedSpaces.value.filter((space) => {
    if (space.isDefault) return true;
    const parts = (space.relativePath || "").split("/");
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  }),
);

function hasChildren(space: MemorySpace): boolean {
  const prefix = space.relativePath ? `${space.relativePath}/` : "";
  return props.spaces.some((candidate) =>
    space.isDefault
      ? Boolean(candidate.relativePath)
      : candidate.relativePath?.startsWith(prefix),
  );
}

function isCollapsed(space: MemorySpace): boolean {
  return collapsedFolders.value.has(space.relativePath || "");
}

function readCollapsedFolders(): Set<string> {
  try {
    const raw = sessionStorage.getItem(COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedFolders(): void {
  try {
    sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedFolders.value]));
  } catch {
    /* ignore storage failures */
  }
}

function toggleFolder(space: MemorySpace) {
  const key = space.relativePath || "";
  const next = new Set(collapsedFolders.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedFolders.value = next;
  writeCollapsedFolders();
}

function selectSpace(spaceId: string) {
  emit("update:selectedSpaceId", spaceId);
}

function onDragEnter(e: DragEvent, spaceId?: string) {
  e.preventDefault();
  if (spaceId) dropTargetSpaceId.value = spaceId;
  else dragCounter.value++;
}

function onDragLeave(e: DragEvent, spaceId?: string) {
  e.preventDefault();
  if (spaceId) {
    if (dropTargetSpaceId.value === spaceId) dropTargetSpaceId.value = null;
  } else {
    dragCounter.value = Math.max(0, dragCounter.value - 1);
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DOCUMENT_DRAG_MIME) ? "move" : "copy";
  }
}

async function onFolderDrop(e: DragEvent, targetSpaceId: string) {
  e.preventDefault();
  dropTargetSpaceId.value = null;
  const documentPayload = e.dataTransfer?.getData(DOCUMENT_DRAG_MIME);
  if (documentPayload) {
    try {
      const parsed = JSON.parse(documentPayload) as { sourceFiles?: unknown };
      const sourceFiles = Array.isArray(parsed.sourceFiles)
        ? parsed.sourceFiles.filter((value): value is string => typeof value === "string")
        : [];
      if (sourceFiles.length) await docList.value?.moveGroupsToSpace(targetSpaceId, sourceFiles);
    } catch {
      /* ignore malformed drag payload */
    }
    return;
  }
  await onFileDrop(e, targetSpaceId);
}

async function onFileDrop(e: DragEvent, targetSpaceId?: string) {
  e.preventDefault();
  dragCounter.value = 0;
  dropTargetSpaceId.value = null;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const spaceId = targetSpaceId || props.selectedSpaceId;
  if (!spaceId) return;
  if (spaceId !== props.selectedSpaceId) emit("update:selectedSpaceId", spaceId);
  await nextTick();
  docList.value?.ingestFiles(Array.from(files));
}
</script>
<template>
  <div
    class="relative p-4 sm:p-6 lg:p-8"
    @dragenter="onDragEnter($event)"
    @dragleave="onDragLeave($event)"
    @dragover="onDragOver($event)"
    @drop="onFileDrop($event)"
  >
    <div
      v-if="dragCounter > 0 && selectedSpaceId && !dropTargetSpaceId"
      class="absolute inset-4 z-40 flex items-center justify-center bg-accent-500/10 border-2 border-dashed border-accent-500/40 rounded-xl pointer-events-none sm:inset-6 lg:inset-8"
    >
      <div class="text-center">
        <Icon
          icon="lucide:upload-cloud"
          class="w-12 h-12 text-accent-400 mx-auto mb-2"
        />
        <p class="text-accent-300 font-medium">
          Drop files into {{ selectedSpace?.name || "selected folder" }}
        </p>
      </div>
    </div>

    <div class="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div class="rounded-xl border border-theme-800 overflow-hidden bg-theme-950/45">
        <div class="flex items-center justify-between px-4 py-3 border-b border-theme-800 bg-theme-900/50">
          <div class="text-xs font-medium uppercase tracking-wide text-theme-400">
            Folders
          </div>
          <button
            class="p-1.5 text-theme-500 hover:text-theme-200 transition-colors"
            title="Refresh folders"
            @click="emit('refresh-spaces')"
          >
            <Icon
              icon="lucide:refresh-cw"
              class="w-4 h-4"
              :class="{ 'animate-spin': spacesLoading }"
            />
          </button>
        </div>
        <div
          v-if="spaces.length === 0"
          class="px-4 py-8 text-center text-sm text-theme-500"
        >
          No memory folder found.
        </div>
        <div
          v-else
          class="py-1"
        >
          <div
            v-for="space in visibleSpaces"
            :key="space.id"
            class="group flex items-center gap-2 px-3 py-2.5 border-b border-theme-900/70 last:border-b-0 transition-colors"
            :class="[
              selectedSpaceId === space.id ? 'bg-accent-500/12 text-theme-100' : 'hover:bg-theme-800/35 text-theme-300',
              dropTargetSpaceId === space.id ? 'ring-1 ring-accent-500/70 ring-inset bg-accent-500/10' : '',
            ]"
            @dragenter.stop="onDragEnter($event, space.id)"
            @dragleave.stop="onDragLeave($event, space.id)"
            @dragover.stop="onDragOver($event)"
            @drop.stop="onFolderDrop($event, space.id)"
          >
            <!-- Indent spacer, change this to adjust starting padding -->
            <span
              v-if="(space.depth || 0) > 0"
              :style="{ width: `${(space.depth || 0) * 8}px` }"
              class="shrink-0"
            />
            <!-- Chevron: always rendered to keep all rows aligned -->
            <button
              class="p-0.5 shrink-0 text-theme-500 hover:text-theme-200 transition-colors"
              :class="{
                'invisible pointer-events-none': space.isDefault || !hasChildren(space),
              }"
              @click.stop="toggleFolder(space)"
            >
              <Icon
                icon="lucide:chevron-down"
                class="w-4 h-4 transition-transform"
                :class="{ '-rotate-90': isCollapsed(space) }"
              />
            </button>
            <!-- Folder name -->
            <button
              class="min-w-0 flex flex-1 items-center gap-2 text-left"
              @click="selectSpace(space.id)"
            >
              <Icon
                :icon="space.isDefault ? 'lucide:hard-drive' : isCollapsed(space) ? 'lucide:folder' : 'lucide:folder-open'"
                class="w-4 h-4 shrink-0"
                :class="space.isDefault ? 'text-accent-400' : 'text-amber-400'"
              />
              <span class="truncate text-sm font-medium">{{ space.name }}</span>
              <span class="text-xs text-theme-500">{{ space.fileCount }}</span>
            </button>
            <!-- Action buttons -->
            <button
              class="p-1 text-theme-600 hover:text-accent-400 opacity-0 group-hover:opacity-100 transition-colors"
              title="New subfolder"
              @click.stop="emit('create-folder', space)"
            >
              <Icon
                icon="lucide:plus"
                class="w-3.5 h-3.5"
              />
            </button>
            <button
              class="p-1 text-theme-600 hover:text-theme-200 opacity-0 group-hover:opacity-100 transition-colors"
              title="Rename folder"
              @click.stop="emit('edit-folder', space)"
            >
              <Icon
                icon="lucide:pencil"
                class="w-3.5 h-3.5"
              />
            </button>
            <button
              :disabled="space.isDefault"
              class="p-1 text-theme-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-colors disabled:opacity-20 disabled:hover:text-theme-600"
              title="Archive folder"
              @click.stop="emit('delete-folder', space)"
            >
              <Icon
                icon="lucide:archive"
                class="w-3.5 h-3.5"
              />
            </button>
          </div>
        </div>
      </div>

      <MemoryDocumentList
        v-if="selectedSpaceId"
        ref="docList"
        :space-id="selectedSpaceId"
        :spaces="spaces"
        @edit-space="selectedSpace && emit('edit-folder', selectedSpace)"
        @delete-space="selectedSpace && emit('delete-folder', selectedSpace)"
        @spaces-changed="emit('refresh-spaces')"
      />
    </div>
  </div>
</template>
