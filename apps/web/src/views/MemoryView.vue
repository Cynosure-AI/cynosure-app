<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Icon } from "@iconify/vue";
import { api } from "../api/client";
import type { MemoryFolder } from "../api/types";
import ModalDialog from "../components/shared/ModalDialog.vue";
import MemoryDocumentSection from "../components/memory/MemoryDocumentSection.vue";

const spaces = ref<MemoryFolder[]>([]);
const spacesLoading = ref(false);
const selectedFolderId = ref<string | null>(null);
const showCreateDialog = ref(false);
const editingFolder = ref<MemoryFolder | null>(null);
const parentForCreate = ref<MemoryFolder | null>(null);
const folderName = ref("");
const folderDescription = ref("");
const showDeleteConfirm = ref(false);
const pendingDeleteFolder = ref<MemoryFolder | null>(null);
const activeDocumentView = ref<"folder" | "recent" | "trash">("folder");

const route = useRoute();
const router = useRouter();
const linkedFolderId = computed(() => typeof route.query.folder === "string" ? route.query.folder : "");
const linkedFileName = computed(() => typeof route.query.file === "string" ? route.query.file : "");

function selectDocumentView(view: "folder" | "recent" | "trash") {
  activeDocumentView.value = view;
}

function selectFolderView() {
  activeDocumentView.value = "folder";
  clearDocumentLink();
}

const selectedFolder = computed(() =>
  spaces.value.find((s) => s.id === selectedFolderId.value) || null,
);

async function loadFolders() {
  spacesLoading.value = true;
  try {
    const loaded = await api.memoryFolders.list();
    spaces.value = [...loaded].sort((a, b) => {
      if (a.isUncategorized) return -1;
      if (b.isUncategorized) return 1;
      return (a.folderPath || "").localeCompare(b.folderPath || "");
    });
    if (linkedFolderId.value && spaces.value.some(space => space.id === linkedFolderId.value)) {
      selectedFolderId.value = linkedFolderId.value;
    }
    if (!selectedFolderId.value && spaces.value.length > 0) selectedFolderId.value = spaces.value[0].id;
    if (selectedFolderId.value && !spaces.value.some((s) => s.id === selectedFolderId.value)) {
      selectedFolderId.value = spaces.value[0]?.id || null;
    }
  } catch {
    spaces.value = [];
  }
  spacesLoading.value = false;
}

function openCreateDialog(parent?: MemoryFolder) {
  editingFolder.value = null;
  parentForCreate.value = parent || selectedFolder.value;
  folderName.value = "";
  folderDescription.value = "";
  showCreateDialog.value = true;
}

function openEditDialog(space: MemoryFolder) {
  if (space.isUncategorized) return;
  editingFolder.value = space;
  parentForCreate.value = null;
  folderName.value = space.name;
  folderDescription.value = space.description;
  showCreateDialog.value = true;
}

function relativePathForName(space: MemoryFolder, name: string): string {
  const trimmed = name.trim();
  if (space.isUncategorized) return "";
  const current = space.folderPath || "";
  const slash = current.lastIndexOf("/");
  return slash >= 0 ? `${current.slice(0, slash)}/${trimmed}` : trimmed;
}

async function saveFolder() {
  if (!folderName.value.trim()) return;
  try {
    if (editingFolder.value) {
      const data: { name?: string; description?: string; folderPath?: string } = {
        name: folderName.value.trim(),
        description: folderDescription.value,
      };
      if (!editingFolder.value.isUncategorized) data.folderPath = relativePathForName(editingFolder.value, folderName.value);
      const updated = await api.memoryFolders.update(editingFolder.value.id, data);
      selectedFolderId.value = updated.id;
    } else {
      const created = await api.memoryFolders.create(
        folderName.value.trim(),
        folderDescription.value,
        parentForCreate.value?.folderPath || "",
      );
      selectedFolderId.value = created.id;
    }
    await loadFolders();
  } catch {
    /* surface errors later with shared notifications */
  }
  showCreateDialog.value = false;
}

function confirmDeleteSpace(space: MemoryFolder) {
  const prefix = space.folderPath ? `${space.folderPath}/` : "";
  const hasSubfolders = Boolean(prefix && spaces.value.some(candidate => candidate.folderPath?.startsWith(prefix)));
  if (space.fileCount === 0 && !hasSubfolders) {
    void deleteSpace(space);
    return;
  }
  pendingDeleteFolder.value = space;
  showDeleteConfirm.value = true;
}

async function deleteSpace(space: MemoryFolder) {
  showDeleteConfirm.value = false;
  pendingDeleteFolder.value = null;
  try {
    await api.memoryFolders.remove(space.id);
    await loadFolders();
  } catch {
    /* ignore */
  }
}

async function toggleAutoMemoryExclusion(space: MemoryFolder) {
  try {
    await api.memoryFolders.update(space.id, { autoMemoryExcluded: !space.autoMemoryExcluded });
    await loadFolders();
  } catch {
    /* surface errors later with shared notifications */
  }
}

function clearDocumentLink(): void {
  if (!linkedFolderId.value && !linkedFileName.value) return;
  const query = { ...route.query };
  delete query.folder;
  delete query.file;
  void router.replace({ path: route.path, query });
}

watch(linkedFolderId, (folderId) => {
  if (folderId && spaces.value.some(space => space.id === folderId)) {
    selectedFolderId.value = folderId;
    activeDocumentView.value = "folder";
  }
});

onMounted(() => loadFolders());
</script>

<template>
  <div class="relative h-full min-w-0 overflow-y-auto">
    <div class="min-h-full min-w-0">
      <main class="flex min-h-full min-w-0 flex-col">
        <header class="z-10 border-b border-theme-700/60 bg-page-header/95 py-4 backdrop-blur-sm sm:sticky sm:top-0 sm:py-5">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <h1 class="text-2xl font-bold text-theme-100">
                  Memory
                </h1>
                <p class="mt-1 text-sm leading-relaxed text-ink-muted">
                  Browse folders, upload files, and manage indexed memory documents.
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2 self-start">
                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
                  :class="activeDocumentView === 'recent'
                    ? 'border-accent-500/40 bg-accent-500/10 text-accent-fg'
                    : 'border-theme-700/70 bg-control-surface text-ink-secondary hover:border-theme-700 hover:text-theme-200'"
                  @click="selectDocumentView('recent')"
                >
                  <Icon
                    icon="lucide:history"
                    class="h-4 w-4"
                  />
                  Recent Documents
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
                  :class="activeDocumentView === 'trash'
                    ? 'border-red-500/35 bg-red-500/10 text-red-300'
                    : 'border-theme-700/70 bg-control-surface text-ink-secondary hover:border-theme-700 hover:text-theme-200'"
                  @click="selectDocumentView('trash')"
                >
                  <Icon
                    icon="lucide:trash-2"
                    class="h-4 w-4"
                  />
                  Trash
                </button>
              </div>
            </div>
          </div>
        </header>

        <div
          v-if="spacesLoading && spaces.length === 0"
          class="flex items-center gap-2 py-8 justify-center text-ink-muted"
        >
          <Icon
            icon="lucide:loader-2"
            class="w-5 h-5 animate-spin"
          />
          Loading folders...
        </div>

        <MemoryDocumentSection
          v-else
          v-model:selected-folder-id="selectedFolderId"
          class="mx-auto w-full max-w-7xl"
          :spaces="spaces"
          :spaces-loading="spacesLoading"
          :selected-folder="selectedFolder"
          :active-view="activeDocumentView"
          :focus-file="linkedFileName"
          @create-folder="openCreateDialog"
          @edit-folder="openEditDialog"
          @delete-folder="confirmDeleteSpace"
          @toggle-auto-memory-exclusion="toggleAutoMemoryExclusion"
          @refresh-spaces="loadFolders"
          @folder-navigation="selectFolderView"
          @select-view="selectDocumentView"
        />
      </main>

      <Teleport to="body">
        <div
          v-if="showCreateDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          @click.self="showCreateDialog = false"
        >
          <div class="bg-theme-900 border border-theme-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 class="text-base font-medium text-theme-200 mb-4">
              {{ editingFolder ? "Edit Folder" : "New Memory Folder" }}
            </h3>
            <div class="space-y-3">
              <div
                v-if="!editingFolder"
                class="text-xs text-ink-muted"
              >
                Parent: <span class="text-theme-300">{{ parentForCreate?.name || "Uncategorized" }}</span>
              </div>
              <div>
                <label class="block text-xs text-ink-secondary mb-1">Name</label>
                <input
                  v-model="folderName"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder:text-ink-muted focus:outline-none focus:border-theme-500"
                  placeholder="e.g. Project Notes"
                  @keydown.enter="saveFolder"
                >
                <div class="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-muted">
                  <Icon
                    icon="lucide:info"
                    class="mt-0.5 h-3 w-3 shrink-0"
                  />
                  <span>
                    New folders are included in automatic memory routing by default. You can exclude them from the folder menu at any time.
                  </span>
                </div>
              </div>
              <div>
                <label class="block text-xs text-ink-secondary mb-1">Description (optional)</label>
                <input
                  v-model="folderDescription"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder:text-ink-muted focus:outline-none focus:border-theme-500"
                >
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <button
                class="px-3 py-1.5 text-sm text-ink-secondary hover:text-theme-200"
                @click="showCreateDialog = false"
              >
                Cancel
              </button>
              <button
                :disabled="!folderName.trim()"
                class="px-4 py-1.5 accent-action bg-accent-600 hover:bg-accent-500 text-accent-on text-sm rounded-lg disabled:opacity-50"
                @click="saveFolder"
              >
                {{ editingFolder ? "Save" : "Create" }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <ModalDialog
        :show="showDeleteConfirm"
        title="Remove Memory Folder"
        icon="lucide:trash-2"
        icon-color="red"
        @close="showDeleteConfirm = false"
      >
        <p class="text-ink-secondary leading-relaxed">
          Remove <strong class="text-theme-200">{{ pendingDeleteFolder?.name }}</strong>? Its folder will be moved to the memory trash and its indexes will be removed.
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="deleteSpace(pendingDeleteFolder!)"
          >
            Remove Folder
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
