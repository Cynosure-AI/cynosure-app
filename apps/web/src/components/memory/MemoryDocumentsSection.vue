<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { MemoryCategory } from "../../api/types";
import MemoryDocumentList from "./MemoryDocumentList.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";
const COLLAPSED_KEY = "cy-memory-folder-collapsed";

interface DocumentDragPayload {
  sourceCategoryId?: string;
  sourceFiles?: unknown;
}

const props = defineProps<{
  spaces: MemoryCategory[];
  spacesLoading: boolean;
  selectedCategoryId: string | null;
  selectedCategory: MemoryCategory | null;
}>();

const emit = defineEmits<{
  "update:selectedCategoryId": [value: string | null];
  "create-folder": [parent?: MemoryCategory];
  "edit-folder": [space: MemoryCategory];
  "delete-folder": [space: MemoryCategory];
  "refresh-spaces": [];
}>();

const docList = ref<InstanceType<typeof MemoryDocumentList> | null>(null);
const collapsedFolders = ref<Set<string>>(readCollapsedFolders());
const dragCounter = ref(0);
const dropTargetSpaceId = ref<string | null>(null);

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

function hasChildren(space: MemoryCategory): boolean {
  const prefix = space.categoryPath ? `${space.categoryPath}/` : "";
  return props.spaces.some((candidate) =>
    space.isUncategorized
      ? Boolean(candidate.categoryPath)
      : candidate.categoryPath?.startsWith(prefix),
  );
}

function isCollapsed(space: MemoryCategory): boolean {
  return collapsedFolders.value.has(space.categoryPath || "");
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

function toggleFolder(space: MemoryCategory) {
  const key = space.categoryPath || "";
  const next = new Set(collapsedFolders.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedFolders.value = next;
  writeCollapsedFolders();
}

function selectSpace(categoryId: string) {
  emit("update:selectedCategoryId", categoryId);
}

function isDocumentDrag(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes(DOCUMENT_DRAG_MIME) ?? false;
}

function isFileDrag(e: DragEvent): boolean {
  return !isDocumentDrag(e) && (e.dataTransfer?.types.includes("Files") ?? false);
}

function onDragEnter(e: DragEvent, categoryId?: string) {
  if (categoryId) {
    if (!isDocumentDrag(e)) return;
    e.preventDefault();
    // A document is already in the selected category, so it cannot be moved there.
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
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DOCUMENT_DRAG_MIME) ? "move" : "copy";
  }
}

async function onFolderDrop(e: DragEvent, targetCategoryId: string) {
  const documentPayload = e.dataTransfer?.getData(DOCUMENT_DRAG_MIME);
  if (!documentPayload) return;
  e.preventDefault();
  dropTargetSpaceId.value = null;
  try {
    const parsed = JSON.parse(documentPayload) as DocumentDragPayload;
    const sourceCategoryId = typeof parsed.sourceCategoryId === "string" ? parsed.sourceCategoryId : props.selectedCategoryId;
    const sourceFiles = Array.isArray(parsed.sourceFiles)
      ? parsed.sourceFiles.filter((value): value is string => typeof value === "string")
      : [];
    if (!sourceCategoryId || sourceCategoryId === targetCategoryId || sourceFiles.length === 0) return;
    if (sourceCategoryId === props.selectedCategoryId) {
      await docList.value?.moveDocumentsToCategory(targetCategoryId, sourceFiles);
    } else {
      await api.memoryCategories.moveDocuments(sourceCategoryId, sourceFiles, targetCategoryId);
      emit("refresh-spaces");
    }
  } catch {
    /* ignore malformed drag payload */
  }
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
          No memory category found.
        </div>
        <div
          v-else
          class="py-1"
        >
          <div
            v-for="space in visibleSpaces"
            :key="space.id"
            :data-space-id="space.id"
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
            <!-- Indent spacer, change this to adjust starting padding -->
            <span
              v-if="(space.depth || 0) > 1"
              :style="{ width: `${((space.depth || 0) * 12)}px` }"
              class="shrink-0"
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
              <span class="truncate text-sm font-medium">{{ space.name }}</span>
              <span class="text-xs text-theme-500">{{ space.fileCount }}</span>
            </button>
            <!-- Action buttons -->
            <button
              class="p-1 text-theme-600 hover:text-accent-400 opacity-0 group-hover:opacity-100 transition-colors"
              title="New subcategory"
              @click.stop="emit('create-folder', space)"
            >
              <Icon
                icon="lucide:plus"
                class="w-3.5 h-3.5"
              />
            </button>
            <button
              class="p-1 text-theme-600 hover:text-theme-200 opacity-0 group-hover:opacity-100 transition-colors"
              title="Rename category"
              @click.stop="emit('edit-folder', space)"
            >
              <Icon
                icon="lucide:pencil"
                class="w-3.5 h-3.5"
              />
            </button>
            <button
              :disabled="space.isUncategorized"
              class="p-1 text-theme-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-colors disabled:opacity-20 disabled:hover:text-theme-600"
              title="Remove folder"
              @click.stop="emit('delete-folder', space)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-3.5 h-3.5"
              />
            </button>
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
              Drop files into {{ selectedCategory?.name || "selected category" }}
            </p>
          </div>
        </div>

        <MemoryDocumentList
          ref="docList"
          :category-id="selectedCategoryId"
          :spaces="spaces"
          @edit-space="selectedCategory && emit('edit-folder', selectedCategory)"
          @delete-space="selectedCategory && emit('delete-folder', selectedCategory)"
          @spaces-changed="emit('refresh-spaces')"
        />
      </div>
    </div>
  </div>
</template>
