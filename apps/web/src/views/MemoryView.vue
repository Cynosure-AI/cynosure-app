<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Icon } from "@iconify/vue";
import { api } from "../api/client";
import type { MemoryFolder } from "../api/types";
import MemoryFolderDialogs from "../components/memory/MemoryFolderDialogs.vue";
import MemoryDocumentSection from "../components/memory/MemoryDocumentSection.vue";

const spaces = ref<MemoryFolder[]>([]);
const spacesLoading = ref(false);
const selectedFolderId = ref<string | null>(null);
const folderDialogs = ref<InstanceType<typeof MemoryFolderDialogs> | null>(null);
const actionError = ref("");
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

function showFolder(folderId: string): void {
  selectedFolderId.value = folderId;
  void loadFolders();
}

function showError(message: string): void {
  actionError.value = message;
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
        <header class="page-header z-10 border-b border-theme-700/60 bg-page-header/95 py-4 backdrop-blur-sm sm:sticky sm:top-0 sm:py-5">
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

        <p
          v-if="actionError"
          role="alert"
          class="mx-auto mt-4 flex w-full max-w-7xl items-center gap-2 px-4 text-sm text-status-danger sm:px-6 lg:px-8"
        >
          <Icon
            icon="lucide:circle-alert"
            class="h-4 w-4 shrink-0"
          />
          <span class="min-w-0 flex-1">{{ actionError }}</span>
          <button
            type="button"
            class="shrink-0 rounded p-1 hover:bg-status-danger/10"
            aria-label="Dismiss error"
            @click="actionError = ''"
          >
            <Icon
              icon="lucide:x"
              class="h-3.5 w-3.5"
            />
          </button>
        </p>

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
          class="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8"
          :spaces="spaces"
          :spaces-loading="spacesLoading"
          :selected-folder="selectedFolder"
          :active-view="activeDocumentView"
          :focus-file="linkedFileName"
          @create-folder="folderDialogs?.openCreate($event ?? selectedFolder)"
          @edit-folder="folderDialogs?.openEdit($event)"
          @delete-folder="folderDialogs?.confirmRemove($event)"
          @toggle-auto-memory-exclusion="folderDialogs?.toggleAutoMemoryExclusion($event)"
          @refresh-spaces="loadFolders"
          @folder-navigation="selectFolderView"
          @select-view="selectDocumentView"
        />
      </main>

      <MemoryFolderDialogs
        ref="folderDialogs"
        :spaces="spaces"
        @saved="showFolder"
        @changed="loadFolders"
        @removed="loadFolders"
        @error="showError"
      />
    </div>
  </div>
</template>
