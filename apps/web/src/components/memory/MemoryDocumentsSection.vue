<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { MemoryFolder } from "../../api/types";
import MemoryDocumentList from "./MemoryDocumentList.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";
const COLLAPSED_KEY = "cy-memory-folder-collapsed";

interface DocumentDragPayload {
  sourceCategoryId?: string;
  sourceFiles?: unknown;
}

const props = defineProps<{
  spaces: MemoryFolder[];
  spacesLoading: boolean;
  selectedCategoryId: string | null;
  selectedCategory: MemoryFolder | null;
  focusFile?: string;
}>();

const emit = defineEmits<{
  "update:selectedCategoryId": [value: string | null];
  "create-folder": [parent?: MemoryFolder];
  "edit-folder": [space: MemoryFolder];
  "delete-folder": [space: MemoryFolder];
  "refresh-spaces": [];
  "category-navigation": [];
}>();

const docList = ref<InstanceType<typeof MemoryDocumentList> | null>(null);
const collapsedFolders = ref<Set<string>>(new Set());
let folderStateInitialized = false;
const dragCounter = ref(0);
const dropTargetSpaceId = ref<string | null>(null);
const activeDocumentDrag = ref<DocumentDragPayload | null>(null);
const openFolderMenuId = ref<string | null>(null);
const folderMenuStyle = ref<Record<string, string>>({});

const openFolderMenuSpace = computed(() =>
  props.spaces.find((space) => space.id === openFolderMenuId.value) || null,
);

function toggleFolderMenu(space: MemoryFolder, event: MouseEvent): void {
  if (openFolderMenuId.value === space.id) {
    openFolderMenuId.value = null;
    return;
  }

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const menuHeight = 106;
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

const sortedSpaces = computed(() =>
  [...props.spaces].sort((a, b) => {
    if (a.isUncategorized) return -1;
    if (b.isUncategorized) return 1;
    return (a.categoryPath || "").localeCompare(b.categoryPath || "");
  }),
);

const visibleSpaces = computed(() =>
  sortedSpaces.value.filter((space) => {
    if (space.isUncategorized) return true;
    const parts = (space.categoryPath || "").split("/");
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.value.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  }),
);

function hasChildren(space: MemoryFolder): boolean {
  const prefix = space.categoryPath ? `${space.categoryPath}/` : "";
  return props.spaces.some((candidate) =>
    space.isUncategorized
      ? Boolean(candidate.categoryPath)
      : candidate.categoryPath?.startsWith(prefix),
  );
}

function categoryDepth(space: MemoryFolder): number {
  if (space.isUncategorized) return 0;
  return Math.max(1, (space.categoryPath || "").split("/").filter(Boolean).length);
}

function isCollapsed(space: MemoryFolder): boolean {
  return collapsedFolders.value.has(space.categoryPath || "");
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
      revealFocusedCategory();
      return;
    }
  } catch {
    /* fall back to the default collapsed state */
  }
  if (spaces.length === 0) return;
  collapsedFolders.value = new Set(spaces
    .filter(space => hasChildren(space) && !space.isUncategorized)
    .map(space => space.categoryPath || ""));
  folderStateInitialized = true;
  writeCollapsedFolders();
  revealFocusedCategory();
}

function revealFocusedCategory(): void {
  if (!props.focusFile || !props.selectedCategoryId) return;
  const category = props.spaces.find(space => space.id === props.selectedCategoryId);
  const parts = (category?.categoryPath || "").split("/").filter(Boolean);
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
  const key = space.categoryPath || "";
  const next = new Set(collapsedFolders.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedFolders.value = next;
  writeCollapsedFolders();
}

watch(() => props.spaces, initializeFolderState, { immediate: true });
watch([() => props.focusFile, () => props.selectedCategoryId], revealFocusedCategory);

function selectSpace(categoryId: string) {
  openFolderMenuId.value = null;
  emit("update:selectedCategoryId", categoryId);
  emit("category-navigation");
}

function isDocumentDrag(e: DragEvent): boolean {
  return Boolean(activeDocumentDrag.value) || Array.from(e.dataTransfer?.types || []).includes(DOCUMENT_DRAG_MIME);
}

function isFileDrag(e: DragEvent): boolean {
  return !isDocumentDrag(e) && (e.dataTransfer?.types.includes("Files") ?? false);
}

function onDragEnter(e: DragEvent, categoryId?: string) {
  if (categoryId) {
    if (!isDocumentDrag(e)) return;
    e.preventDefault();
    // A document is already in the selected folder, so it cannot be moved there.
    if (isDocumentDrag(e) && categoryId === props.selectedCategoryId) return;
    dropTargetSpaceId.value = categoryId;
    return;
  }

  // The document pane is an upload target for OS files only. In-app document
  // drags must pass over it without activating the upload treatment.
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter.value++;
}

function onDragLeave(e: DragEvent, categoryId?: string) {
  e.preventDefault();
  if (categoryId) {
    const current = e.currentTarget as HTMLElement | null;
    const related = e.relatedTarget as Node | null;
    if (current && related && current.contains(related)) return;
    if (dropTargetSpaceId.value === categoryId) dropTargetSpaceId.value = null;
  } else {
    dragCounter.value = Math.max(0, dragCounter.value - 1);
  }
}

function onDragOver(e: DragEvent, categoryId?: string) {
  if (categoryId && !isDocumentDrag(e)) return;
  if (isDocumentDrag(e) && (!categoryId || categoryId === props.selectedCategoryId)) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    return;
  }
  if (!isDocumentDrag(e) && !isFileDrag(e)) return;
  e.preventDefault();
  if (categoryId && categoryId !== props.selectedCategoryId && isDocumentDrag(e)) {
    dropTargetSpaceId.value = categoryId;
  }
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = isDocumentDrag(e) ? "move" : "copy";
  }
}

async function onFolderDrop(e: DragEvent, targetCategoryId: string) {
  const documentPayload = e.dataTransfer?.getData(DOCUMENT_DRAG_MIME)
    || e.dataTransfer?.getData("text/plain");
  if (!documentPayload && !activeDocumentDrag.value) return;
  e.preventDefault();
  dropTargetSpaceId.value = null;
  try {
    const parsed = documentPayload ? JSON.parse(documentPayload) as DocumentDragPayload : activeDocumentDrag.value!;
    const sourceCategoryId = typeof parsed.sourceCategoryId === "string" ? parsed.sourceCategoryId : props.selectedCategoryId;
    const sourceFiles = Array.isArray(parsed.sourceFiles)
      ? parsed.sourceFiles.filter((value): value is string => typeof value === "string")
      : [];
    if (!sourceCategoryId || sourceCategoryId === targetCategoryId || sourceFiles.length === 0) return;
    if (sourceCategoryId === props.selectedCategoryId) {
      await docList.value?.moveDocumentsToCategory(targetCategoryId, sourceFiles);
    } else {
      await api.memoryFolders.moveDocuments(sourceCategoryId, sourceFiles, targetCategoryId);
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

async function openGlobalDocument(categoryId: string, fileName: string) {
  if (categoryId !== props.selectedCategoryId) emit("update:selectedCategoryId", categoryId);
  await nextTick();
  docList.value?.openDocument(fileName);
}

async function onFileDrop(e: DragEvent, targetCategoryId?: string) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter.value = 0;
  dropTargetSpaceId.value = null;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const categoryId = targetCategoryId || props.selectedCategoryId;
  if (!categoryId) return;
  if (categoryId !== props.selectedCategoryId) emit("update:selectedCategoryId", categoryId);
  await nextTick();
  docList.value?.ingestFiles(Array.from(files));
}
</script>
<template>
  <div class="p-4 sm:p-6 lg:p-8">
    <div class="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div class="rounded-xl border border-theme-800 overflow-hidden bg-theme-950/45">
        <div class="flex items-center justify-between px-4 py-3 border-b border-theme-800 bg-theme-900/50">
          <div class="text-xs font-medium uppercase tracking-wide text-theme-400">
            Categories
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
            :data-category-depth="categoryDepth(space)"
            class="group flex items-center gap-2 px-3 py-2.5 border-b border-theme-900/70 last:border-b-0 transition-colors"
            :class="[
              selectedCategoryId === space.id ? 'bg-accent-500/12 text-theme-100' : 'hover:bg-theme-800/35 text-theme-300',
              dropTargetSpaceId === space.id ? 'ring-1 ring-accent-500/70 ring-inset bg-accent-500/10' : '',
            ]"
            @dragenter.stop="onDragEnter($event, space.id)"
            @dragleave.stop="onDragLeave($event, space.id)"
            @dragover.stop="onDragOver($event, space.id)"
            @drop.stop="onFolderDrop($event, space.id)"
          >
            <!-- Uncategorized is the root; every physical category is shown beneath it. -->
            <span
              v-if="categoryDepth(space) > 0"
              :style="{ width: `${categoryDepth(space) * 12}px` }"
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
                :icon="space.isUncategorized ? 'lucide:hard-drive' : isCollapsed(space) ? 'lucide:folder' : 'lucide:folder-open'"
                class="w-4 h-4 shrink-0"
                :class="space.isUncategorized ? 'text-accent-400' : 'text-amber-400'"
              />
              <span
                class="truncate text-sm font-medium"
                :title="space.isUncategorized ? 'Memory root — granting this folder includes every descendant folder' : space.categoryPath"
              >{{ space.name }}</span>
              <span
                v-if="space.isUncategorized"
                class="rounded bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-400"
                title="Folder grants made at the root include all current and future descendants"
              >Root</span>
              <span
                class="text-xs text-theme-500"
                :title="`${space.fileCount} in this folder, ${space.descendantFileCount || 0} in subfolders`"
              >{{ space.fileCount }} ({{ space.descendantFileCount || 0 }})</span>
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
        v-if="selectedCategoryId"
        data-testid="memory-document-drop-zone"
        class="relative min-w-0"
        @dragenter="onDragEnter($event)"
        @dragleave="onDragLeave($event)"
        @dragover="onDragOver($event)"
        @drop="onFileDrop($event)"
      >
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
              Drop files into {{ selectedCategory?.name || "selected folder" }}
            </p>
          </div>
        </div>

        <MemoryDocumentList
          ref="docList"
          :category-id="selectedCategoryId"
          :spaces="spaces"
          :focus-file="focusFile"
          @edit-space="selectedCategory && emit('edit-folder', selectedCategory)"
          @delete-space="selectedCategory && emit('delete-folder', selectedCategory)"
          @spaces-changed="emit('refresh-spaces')"
          @document-drag-state="setDocumentDragState"
          @open-global-document="openGlobalDocument"
        />
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="openFolderMenuSpace"
        data-testid="memory-folder-menu"
        class="z-50 w-40 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
        :style="folderMenuStyle"
        @click.stop
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
          @click="openFolderMenuId = null; emit('create-folder', openFolderMenuSpace)"
        >
          <Icon
            icon="lucide:plus"
            class="h-3.5 w-3.5 text-accent-400"
          />
          Add subfolder
        </button>
        <button
          type="button"
          data-testid="rename-memory-folder"
          :disabled="openFolderMenuSpace.isUncategorized"
          :title="openFolderMenuSpace.isUncategorized ? 'The Uncategorized folder cannot be renamed' : 'Rename folder'"
          class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800 disabled:cursor-not-allowed disabled:opacity-40"
          @click="openFolderMenuId = null; emit('edit-folder', openFolderMenuSpace)"
        >
          <Icon
            icon="lucide:pencil"
            class="h-3.5 w-3.5"
          />
          Rename
        </button>
        <button
          type="button"
          :disabled="openFolderMenuSpace.isUncategorized"
          class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          @click="openFolderMenuId = null; emit('delete-folder', openFolderMenuSpace)"
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
