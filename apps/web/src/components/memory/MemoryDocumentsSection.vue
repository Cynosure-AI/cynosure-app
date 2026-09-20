<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { MemoryFolder } from "../../api/types";
import MemoryDocumentList from "./MemoryDocumentList.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";
const COLLAPSED_KEY = "cy-memory-folder-collapsed";

interface DocumentDragPayload {
  sourceFolderId?: string;
  sourceFiles?: unknown;
}

const props = defineProps<{
  spaces: MemoryFolder[];
  spacesLoading: boolean;
  selectedFolderId: string | null;
  selectedFolder: MemoryFolder | null;
  focusFile?: string;
}>();

const emit = defineEmits<{
  "update:selectedFolderId": [value: string | null];
  "create-folder": [parent?: MemoryFolder];
  "edit-folder": [space: MemoryFolder];
  "delete-folder": [space: MemoryFolder];
  "toggle-auto-memory-exclusion": [space: MemoryFolder];
  "refresh-spaces": [];
  "folder-navigation": [];
}>();

const docList = ref<InstanceType<typeof MemoryDocumentList> | null>(null);
const collapsedFolders = ref<Set<string>>(new Set());
let folderStateInitialized = false;
const dragCounter = ref(0);
const dropTargetSpaceId = ref<string | null>(null);
const activeDocumentDrag = ref<DocumentDragPayload | null>(null);
const openFolderMenuId = ref<string | null>(null);
const folderMenuStyle = ref<Record<string, string>>({});
const mobileDocumentsVisible = ref(Boolean(props.focusFile));

const openFolderMenuSpace = computed(() =>
  props.spaces.find((space) => space.id === openFolderMenuId.value) || null,
);

function toggleFolderMenu(space: MemoryFolder, event: MouseEvent): void {
  if (openFolderMenuId.value === space.id) {
    openFolderMenuId.value = null;
    return;
  }

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const menuHeight = 146;
  const viewportGap = 8;
  const anchorGap = 4;
  const openAbove = rect.bottom + anchorGap + menuHeight > window.innerHeight - viewportGap;
  folderMenuStyle.value = {
    position: "fixed",
    right: `${Math.max(viewportGap, window.innerWidth - rect.right)}px`,
    ...(openAbove
      ? { bottom: `${window.innerHeight - rect.top + anchorGap}px` }
      : { top: `${rect.bottom + anchorGap}px` }),
  };
  openFolderMenuId.value = space.id;
}

function createSubfolderFromMenu(): void {
  const space = openFolderMenuSpace.value;
  if (!space) return;
  openFolderMenuId.value = null;
  emit("create-folder", space);
}

function editFolderFromMenu(): void {
  const space = openFolderMenuSpace.value;
  if (!space) return;
  openFolderMenuId.value = null;
  emit("edit-folder", space);
}

function deleteFolderFromMenu(): void {
  const space = openFolderMenuSpace.value;
  if (!space) return;
  openFolderMenuId.value = null;
  emit("delete-folder", space);
}

function toggleAutoMemoryExclusionFromMenu(): void {
  const space = openFolderMenuSpace.value;
  if (!space) return;
  openFolderMenuId.value = null;
  emit("toggle-auto-memory-exclusion", space);
}

const sortedSpaces = computed(() =>
  [...props.spaces].sort((a, b) => {
    if (a.isUncategorized) return -1;
    if (b.isUncategorized) return 1;
    return (a.folderPath || "").localeCompare(b.folderPath || "");
  }),
);

const visibleSpaces = computed(() =>
  sortedSpaces.value.filter((space) => {
    if (space.isUncategorized) return true;
    const parts = (space.folderPath || "").split("/");
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  }),
);

function hasChildren(space: MemoryFolder): boolean {
  const prefix = space.folderPath ? `${space.folderPath}/` : "";
  return props.spaces.some((candidate) =>
    space.isUncategorized
      ? Boolean(candidate.folderPath)
      : candidate.folderPath?.startsWith(prefix),
  );
}

function folderDepth(space: MemoryFolder): number {
  if (space.isUncategorized) return 0;
  return Math.max(1, (space.folderPath || "").split("/").filter(Boolean).length);
}

function isCollapsed(space: MemoryFolder): boolean {
  return collapsedFolders.value.has(space.folderPath || "");
}

function initializeFolderState(spaces: MemoryFolder[]): void {
  if (folderStateInitialized) return;
  try {
    const raw = sessionStorage.getItem(COLLAPSED_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      collapsedFolders.value = Array.isArray(parsed)
        ? new Set(parsed.filter((value): value is string => typeof value === "string"))
        : new Set();
      folderStateInitialized = true;
      revealFocusedFolder();
      return;
    }
  } catch {
    /* fall back to the default collapsed state */
  }
  if (spaces.length === 0) return;
  collapsedFolders.value = new Set(spaces
    .filter(space => hasChildren(space) && !space.isUncategorized)
    .map(space => space.folderPath || ""));
  folderStateInitialized = true;
  writeCollapsedFolders();
  revealFocusedFolder();
}

function revealFocusedFolder(): void {
  if (!props.focusFile || !props.selectedFolderId) return;
  const folder = props.spaces.find(space => space.id === props.selectedFolderId);
  const parts = (folder?.folderPath || "").split("/").filter(Boolean);
  if (parts.length < 2) return;
  const next = new Set(collapsedFolders.value);
  for (let i = 1; i < parts.length; i++) next.delete(parts.slice(0, i).join("/"));
  collapsedFolders.value = next;
  writeCollapsedFolders();
}

function writeCollapsedFolders(): void {
  try {
    sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedFolders.value]));
  } catch {
    /* ignore storage failures */
  }
}

function toggleFolder(space: MemoryFolder) {
  const key = space.folderPath || "";
  const next = new Set(collapsedFolders.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedFolders.value = next;
  writeCollapsedFolders();
}

watch(() => props.spaces, initializeFolderState, { immediate: true });
watch([() => props.focusFile, () => props.selectedFolderId], revealFocusedFolder);
watch(() => props.focusFile, (focusFile) => {
  if (focusFile) mobileDocumentsVisible.value = true;
});

function selectSpace(folderId: string) {
  openFolderMenuId.value = null;
  emit("update:selectedFolderId", folderId);
  emit("folder-navigation");
  mobileDocumentsVisible.value = true;
}

function navigateToFolder(folderId: string): void {
  emit("update:selectedFolderId", folderId);
  emit("folder-navigation");
}

function showMobileFolders(): void {
  openFolderMenuId.value = null;
  mobileDocumentsVisible.value = false;
}

function isDocumentDrag(e: DragEvent): boolean {
  return Boolean(activeDocumentDrag.value) || Array.from(e.dataTransfer?.types || []).includes(DOCUMENT_DRAG_MIME);
}

function isFileDrag(e: DragEvent): boolean {
  return !isDocumentDrag(e) && (e.dataTransfer?.types.includes("Files") ?? false);
}

function onDragEnter(e: DragEvent, folderId?: string) {
  if (folderId) {
    if (!isDocumentDrag(e)) return;
    e.preventDefault();
    // A document is already in the selected folder, so it cannot be moved there.
    if (isDocumentDrag(e) && folderId === props.selectedFolderId) return;
    dropTargetSpaceId.value = folderId;
    return;
  }

  // The document pane is an upload target for OS files only. In-app document
  // drags must pass over it without activating the upload treatment.
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter.value++;
}

function onDragLeave(e: DragEvent, folderId?: string) {
  e.preventDefault();
  if (folderId) {
    const current = e.currentTarget as HTMLElement | null;
    const related = e.relatedTarget as Node | null;
    if (current && related && current.contains(related)) return;
    if (dropTargetSpaceId.value === folderId) dropTargetSpaceId.value = null;
  } else {
    dragCounter.value = Math.max(0, dragCounter.value - 1);
  }
}

function onDragOver(e: DragEvent, folderId?: string) {
  if (folderId && !isDocumentDrag(e)) return;
  if (isDocumentDrag(e) && (!folderId || folderId === props.selectedFolderId)) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    return;
  }
  if (!isDocumentDrag(e) && !isFileDrag(e)) return;
  e.preventDefault();
  if (folderId && folderId !== props.selectedFolderId && isDocumentDrag(e)) {
    dropTargetSpaceId.value = folderId;
  }
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = isDocumentDrag(e) ? "move" : "copy";
  }
}

async function onFolderDrop(e: DragEvent, targetFolderId: string) {
  const documentPayload = e.dataTransfer?.getData(DOCUMENT_DRAG_MIME)
    || e.dataTransfer?.getData("text/plain");
  if (!documentPayload && !activeDocumentDrag.value) return;
  e.preventDefault();
  dropTargetSpaceId.value = null;
  try {
    const parsed = documentPayload ? JSON.parse(documentPayload) as DocumentDragPayload : activeDocumentDrag.value!;
    const sourceFolderId = typeof parsed.sourceFolderId === "string" ? parsed.sourceFolderId : props.selectedFolderId;
    const sourceFiles = Array.isArray(parsed.sourceFiles)
      ? parsed.sourceFiles.filter((value): value is string => typeof value === "string")
      : [];
    if (!sourceFolderId || sourceFolderId === targetFolderId || sourceFiles.length === 0) return;
    if (sourceFolderId === props.selectedFolderId) {
      await docList.value?.moveDocumentsToFolder(targetFolderId, sourceFiles);
    } else {
      await api.memoryFolders.moveDocuments(sourceFolderId, sourceFiles, targetFolderId);
      emit("refresh-spaces");
    }
  } catch {
    /* ignore malformed drag payload */
  } finally {
    activeDocumentDrag.value = null;
  }
}

function setDocumentDragState(active: boolean, payload?: DocumentDragPayload) {
  activeDocumentDrag.value = active && payload ? payload : null;
  if (!active) dropTargetSpaceId.value = null;
}

async function openGlobalDocument(folderId: string, fileName: string) {
  if (folderId !== props.selectedFolderId) emit("update:selectedFolderId", folderId);
  await nextTick();
  docList.value?.openDocument(fileName);
}

async function onFileDrop(e: DragEvent, targetFolderId?: string) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter.value = 0;
  dropTargetSpaceId.value = null;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const folderId = targetFolderId || props.selectedFolderId;
  if (!folderId) return;
  if (folderId !== props.selectedFolderId) emit("update:selectedFolderId", folderId);
  await nextTick();
  docList.value?.ingestFiles(Array.from(files));
}
</script>
<template>
  <div class="p-4 sm:p-6 lg:p-8">
    <div class="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div
        data-testid="memory-folder-pane"
        class="rounded-xl border border-theme-800 overflow-hidden bg-theme-950/45"
        :class="mobileDocumentsVisible ? 'hidden md:block' : 'block'"
      >
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
            :data-space-id="space.id"
            :data-folder-depth="folderDepth(space)"
            :data-auto-memory-excluded="space.autoMemoryExcluded ? 'true' : 'false'"
            class="group flex items-center gap-2 px-3 py-2.5 border-b border-theme-900/70 last:border-b-0 transition-colors"
            :class="[
              selectedFolderId === space.id ? 'bg-accent-500/12 text-theme-100' : 'hover:bg-theme-800/35 text-theme-300',
              dropTargetSpaceId === space.id ? 'ring-1 ring-accent-500/70 ring-inset bg-accent-500/10' : '',
            ]"
            @dragenter.stop="onDragEnter($event, space.id)"
            @dragleave.stop="onDragLeave($event, space.id)"
            @dragover.stop="onDragOver($event, space.id)"
            @drop.stop="onFolderDrop($event, space.id)"
          >
            <!-- Uncategorized is the root; every physical folder is shown beneath it. -->
            <span
              v-if="folderDepth(space) > 0"
              :style="{ width: `${folderDepth(space) * 12}px` }"
              class="relative shrink-0 self-stretch border-r border-theme-800/60"
              aria-hidden="true"
            />
            <!-- Chevron: always rendered to keep all rows aligned -->
            <button
              type="button"
              class="p-0.5 shrink-0 text-theme-500 hover:text-theme-200 transition-colors"
              :aria-label="isCollapsed(space) ? `Expand ${space.name}` : `Collapse ${space.name}`"
              :tabindex="space.isUncategorized || !hasChildren(space) ? -1 : 0"
              :aria-hidden="space.isUncategorized || !hasChildren(space)"
              :class="{
                'invisible pointer-events-none': space.isUncategorized || !hasChildren(space),
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
                :icon="space.isUncategorized ? 'lucide:hard-drive' : space.autoMemoryExcluded ? 'lucide:folder-x' : isCollapsed(space) ? 'lucide:folder' : 'lucide:folder-open'"
                class="w-4 h-4 shrink-0"
                :class="space.autoMemoryExcluded ? 'text-orange-400' : space.isUncategorized ? 'text-accent-400' : 'text-amber-400'"
                :title="space.autoMemoryExcluded ? 'Excluded from Auto Memory Router' : undefined"
              />
              <span
                class="truncate text-sm font-medium"
                :title="space.isUncategorized ? 'Memory root — granting this folder includes every descendant folder' : space.folderPath"
              >{{ space.name }}</span>
              <span
                v-if="space.isUncategorized"
                class="rounded bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-400"
                title="Folder grants made at the root include all current and future descendants"
              >Root</span>
              <span
                class="text-xs text-theme-500"
                :title="hasChildren(space) ? `${space.fileCount} in this folder, ${space.descendantFileCount || 0} in subfolders` : `${space.fileCount} in this folder`"
              >{{ space.fileCount }}<template v-if="hasChildren(space)"> ({{ space.descendantFileCount || 0 }})</template></span>
            </button>
            <span class="relative shrink-0">
              <button
                type="button"
                class="rounded-md p-1 text-theme-500 opacity-0 transition hover:bg-theme-700 hover:text-theme-200 group-hover:opacity-100 focus-visible:opacity-100"
                :class="{ 'bg-theme-700 text-theme-200 opacity-100': openFolderMenuId === space.id }"
                aria-label="Folder options"
                @click.stop="toggleFolderMenu(space, $event)"
              >
                <Icon
                  icon="lucide:ellipsis"
                  class="h-3.5 w-3.5"
                />
              </button>
            </span>
          </div>
        </div>
      </div>

      <div
        v-if="selectedFolderId"
        data-testid="memory-document-drop-zone"
        class="relative min-w-0"
        :class="mobileDocumentsVisible ? 'block' : 'hidden md:block'"
        @dragenter="onDragEnter($event)"
        @dragleave="onDragLeave($event)"
        @dragover="onDragOver($event)"
        @drop="onFileDrop($event)"
      >
        <button
          type="button"
          data-testid="memory-mobile-folder-back"
          class="mb-3 inline-flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-900/70 px-3 py-2 text-sm font-medium text-theme-300 transition hover:border-theme-600 hover:text-theme-100 md:hidden"
          aria-label="Back to memory folders"
          @click="showMobileFolders"
        >
          <Icon
            icon="lucide:arrow-left"
            class="h-4 w-4"
          />
          Folders
        </button>

        <div
          v-if="dragCounter > 0 && !dropTargetSpaceId"
          class="absolute inset-0 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-accent-500/40 bg-accent-500/10 pointer-events-none"
        >
          <div class="text-center">
            <Icon
              icon="lucide:upload-cloud"
              class="w-12 h-12 text-accent-400 mx-auto mb-2"
            />
            <p class="text-accent-300 font-medium">
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
          @spaces-changed="emit('refresh-spaces')"
          @navigate-folder="navigateToFolder"
          @document-drag-state="setDocumentDragState"
          @open-global-document="openGlobalDocument"
        />
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="openFolderMenuSpace"
        data-testid="memory-folder-menu"
        class="z-50 w-64 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
        :style="folderMenuStyle"
        @click.stop
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
          @click="createSubfolderFromMenu"
        >
          <Icon
            icon="lucide:plus"
            class="h-3.5 w-3.5 text-accent-400"
          />
          Add subfolder
        </button>
        <button
          v-if="!openFolderMenuSpace.isUncategorized"
          type="button"
          data-testid="toggle-auto-memory-exclusion"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          @click="toggleAutoMemoryExclusionFromMenu"
        >
          <Icon
            :icon="openFolderMenuSpace.autoMemoryExcluded ? 'lucide:folder-check' : 'lucide:folder-x'"
            class="h-3.5 w-3.5"
            :class="openFolderMenuSpace.autoMemoryExcluded ? 'text-emerald-400' : 'text-orange-400'"
          />
          {{ openFolderMenuSpace.autoMemoryExcluded ? "Include in Auto Memory Router" : "Exclude from Auto Memory Router" }}
        </button>
        <button
          type="button"
          data-testid="rename-memory-folder"
          :disabled="openFolderMenuSpace.isUncategorized"
          :title="openFolderMenuSpace.isUncategorized ? 'The Uncategorized folder cannot be renamed' : 'Rename folder'"
          class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800 disabled:cursor-not-allowed disabled:opacity-40"
          @click="editFolderFromMenu"
        >
          <Icon
            icon="lucide:pencil"
            class="h-3.5 w-3.5"
          />
          Rename
        </button>
        <button
          type="button"
          data-testid="delete-memory-folder"
          :disabled="openFolderMenuSpace.isUncategorized"
          class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          @click="deleteFolderFromMenu"
        >
          <Icon
            icon="lucide:trash-2"
            class="h-3.5 w-3.5"
          />
          Delete
        </button>
      </div>
    </Teleport>
  </div>
</template>
