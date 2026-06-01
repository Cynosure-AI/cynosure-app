<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { api } from "../api/client";
import type { MemorySpace } from "../api/types";
import { Icon } from "@iconify/vue";
import ModalDialog from "../components/shared/ModalDialog.vue";
import MemoryDocumentList from "../components/memory/MemoryDocumentList.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";
const COLLAPSED_KEY = "cy-memory-folder-collapsed";

const spaces = ref<MemorySpace[]>([]);
const spacesLoading = ref(false);
const selectedSpaceId = ref<string | null>(null);
const showCreateDialog = ref(false);
const editingSpace = ref<MemorySpace | null>(null);
const parentForCreate = ref<MemorySpace | null>(null);
const folderName = ref("");
const folderDescription = ref("");
const showDeleteConfirm = ref(false);
const pendingDeleteSpace = ref<MemorySpace | null>(null);
const collapsedFolders = ref<Set<string>>(readCollapsedFolders());

const docList = ref<InstanceType<typeof MemoryDocumentList> | null>(null);

const selectedSpace = computed(() =>
  spaces.value.find((s) => s.id === selectedSpaceId.value) || null,
);

const sortedSpaces = computed(() =>
  [...spaces.value].sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return (a.relativePath || "").localeCompare(b.relativePath || "");
  }),
);

const visibleSpaces = computed(() =>
  sortedSpaces.value.filter((space) => {
    if (space.isDefault) return true;
    const path = space.relativePath || "";
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (collapsedFolders.value.has(ancestor)) return false;
    }
    return true;
  }),
);

function hasChildren(space: MemorySpace): boolean {
  const prefix = space.relativePath ? `${space.relativePath}/` : "";
  return spaces.value.some((candidate) =>
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

async function loadSpaces() {
  spacesLoading.value = true;
  try {
    const loaded = await api.memorySpaces.list();
    spaces.value = [...loaded].sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return (a.relativePath || "").localeCompare(b.relativePath || "");
    });
    if (!selectedSpaceId.value && spaces.value.length > 0) selectedSpaceId.value = spaces.value[0].id;
    if (selectedSpaceId.value && !spaces.value.some((s) => s.id === selectedSpaceId.value)) {
      selectedSpaceId.value = spaces.value[0]?.id || null;
    }
  } catch {
    spaces.value = [];
  }
  spacesLoading.value = false;
}

function openCreateDialog(parent?: MemorySpace) {
  editingSpace.value = null;
  parentForCreate.value = parent || selectedSpace.value;
  folderName.value = "";
  folderDescription.value = "";
  showCreateDialog.value = true;
}

function openEditDialog(space: MemorySpace) {
  editingSpace.value = space;
  parentForCreate.value = null;
  folderName.value = space.name;
  folderDescription.value = space.description;
  showCreateDialog.value = true;
}

function relativePathForName(space: MemorySpace, name: string): string {
  const trimmed = name.trim();
  if (space.isDefault) return "";
  const current = space.relativePath || "";
  const slash = current.lastIndexOf("/");
  return slash >= 0 ? `${current.slice(0, slash)}/${trimmed}` : trimmed;
}

async function saveFolder() {
  if (!folderName.value.trim()) return;
  try {
    if (editingSpace.value) {
      const data: { name?: string; description?: string; relativePath?: string } = {
        name: folderName.value.trim(),
        description: folderDescription.value,
      };
      if (!editingSpace.value.isDefault) data.relativePath = relativePathForName(editingSpace.value, folderName.value);
      const updated = await api.memorySpaces.update(editingSpace.value.id, data);
      selectedSpaceId.value = updated.id;
    } else {
      const created = await api.memorySpaces.create(
        folderName.value.trim(),
        folderDescription.value,
        parentForCreate.value?.relativePath || "",
      );
      selectedSpaceId.value = created.id;
    }
    await loadSpaces();
  } catch {
    /* surface errors later with shared notifications */
  }
  showCreateDialog.value = false;
}

function confirmDeleteSpace(space: MemorySpace) {
  pendingDeleteSpace.value = space;
  showDeleteConfirm.value = true;
}

async function deleteSpace(space: MemorySpace) {
  showDeleteConfirm.value = false;
  pendingDeleteSpace.value = null;
  try {
    await api.memorySpaces.remove(space.id);
    await loadSpaces();
  } catch {
    /* ignore */
  }
}

const dragCounter = ref(0);
const dropTargetSpaceId = ref<string | null>(null);

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
  const spaceId = targetSpaceId || selectedSpaceId.value;
  if (!spaceId) return;
  if (spaceId !== selectedSpaceId.value) selectedSpaceId.value = spaceId;
  await nextTick();
  docList.value?.ingestFiles(Array.from(files));
}

onMounted(() => loadSpaces());
</script>

<template>
  <div
    class="h-full overflow-y-auto relative"
    @dragenter="onDragEnter($event)"
    @dragleave="onDragLeave($event)"
    @dragover="onDragOver($event)"
    @drop="onFileDrop($event)"
  >
    <div
      v-if="dragCounter > 0 && selectedSpaceId && !dropTargetSpaceId"
      class="absolute inset-0 z-40 flex items-center justify-center bg-accent-500/10 border-2 border-dashed border-accent-500/40 rounded-xl pointer-events-none"
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

    <div class="max-w-6xl mx-auto px-6 py-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-theme-100">
            Memory Folders
          </h1>
          <p class="text-sm text-theme-500 mt-1">
            Organize shared knowledge in one memory folder with searchable subfolders.
          </p>
        </div>
        <button
          class="px-3 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          @click="openCreateDialog()"
        >
          <Icon
            icon="lucide:folder-plus"
            class="w-4 h-4"
          />
          New Folder
        </button>
      </div>

      <div
        v-if="spacesLoading && spaces.length === 0"
        class="flex items-center gap-2 py-8 justify-center text-theme-500"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-5 h-5 animate-spin"
        />
        Loading folders...
      </div>

      <template v-else>
        <div class="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div class="rounded-xl border border-theme-800 overflow-hidden bg-theme-950/45">
            <div class="flex items-center justify-between px-4 py-3 border-b border-theme-800 bg-theme-900/50">
              <div class="text-xs font-medium uppercase tracking-wide text-theme-400">
                Folders
              </div>
              <button
                class="p-1.5 text-theme-500 hover:text-theme-200 transition-colors"
                title="Refresh folders"
                @click="loadSpaces"
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
                :style="{ paddingLeft: `${12 + (space.depth || 0) * 18}px` }"
                @dragenter.stop="onDragEnter($event, space.id)"
                @dragleave.stop="onDragLeave($event, space.id)"
                @dragover.stop="onDragOver($event)"
                @drop.stop="onFolderDrop($event, space.id)"
              >
                <button
                  class="p-0.5 text-theme-500 hover:text-theme-200 transition-colors"
                  :class="{ 'invisible': !hasChildren(space) }"
                  @click.stop="toggleFolder(space)"
                >
                  <Icon
                    icon="lucide:chevron-down"
                    class="w-4 h-4 transition-transform"
                    :class="{ '-rotate-90': isCollapsed(space) }"
                  />
                </button>
                <button
                  class="min-w-0 flex flex-1 items-center gap-2 text-left"
                  @click="selectedSpaceId = space.id"
                >
                  <Icon
                    :icon="space.isDefault ? 'lucide:hard-drive' : isCollapsed(space) ? 'lucide:folder' : 'lucide:folder-open'"
                    class="w-4 h-4 shrink-0"
                    :class="space.isDefault ? 'text-accent-400' : 'text-amber-400'"
                  />
                  <span class="truncate text-sm font-medium">{{ space.name }}</span>
                  <span class="text-xs text-theme-500">{{ space.fileCount }}</span>
                </button>
                <button
                  class="p-1 text-theme-600 hover:text-accent-400 opacity-0 group-hover:opacity-100 transition-colors"
                  title="New subfolder"
                  @click.stop="openCreateDialog(space)"
                >
                  <Icon
                    icon="lucide:plus"
                    class="w-3.5 h-3.5"
                  />
                </button>
                <button
                  class="p-1 text-theme-600 hover:text-theme-200 opacity-0 group-hover:opacity-100 transition-colors"
                  title="Rename folder"
                  @click.stop="openEditDialog(space)"
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
                  @click.stop="confirmDeleteSpace(space)"
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
            @edit-space="selectedSpace && openEditDialog(selectedSpace)"
            @delete-space="selectedSpace && confirmDeleteSpace(selectedSpace)"
            @spaces-changed="loadSpaces"
          />
        </div>
      </template>

      <Teleport to="body">
        <div
          v-if="showCreateDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          @click.self="showCreateDialog = false"
        >
          <div class="bg-theme-900 border border-theme-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 class="text-base font-medium text-theme-200 mb-4">
              {{ editingSpace ? "Edit Folder" : "New Memory Folder" }}
            </h3>
            <div class="space-y-3">
              <div
                v-if="!editingSpace"
                class="text-xs text-theme-500"
              >
                Parent: <span class="text-theme-300">{{ parentForCreate?.name || "Default" }}</span>
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Name</label>
                <input
                  v-model="folderName"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500"
                  placeholder="e.g. Project Notes"
                  @keydown.enter="saveFolder"
                >
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Description (optional)</label>
                <input
                  v-model="folderDescription"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500"
                >
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <button
                class="px-3 py-1.5 text-sm text-theme-400 hover:text-theme-200"
                @click="showCreateDialog = false"
              >
                Cancel
              </button>
              <button
                :disabled="!folderName.trim()"
                class="px-4 py-1.5 bg-accent-600 hover:bg-accent-500 text-white text-sm rounded-lg disabled:opacity-50"
                @click="saveFolder"
              >
                {{ editingSpace ? "Save" : "Create" }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <ModalDialog
        :show="showDeleteConfirm"
        title="Archive Memory Folder"
        icon="lucide:archive"
        icon-color="red"
        @close="showDeleteConfirm = false"
      >
        <p class="text-theme-400 leading-relaxed">
          Archive <strong class="text-theme-200">{{ pendingDeleteSpace?.name }}</strong>? Its folder will be moved to the memory trash and its indexed chunks will be removed.
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="deleteSpace(pendingDeleteSpace!)"
          >
            Archive Folder
          </button>
          <button
            class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
            @click="showDeleteConfirm = false"
          >
            Cancel
          </button>
        </template>
      </ModalDialog>
    </div>
  </div>
</template>
