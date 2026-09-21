<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { MemoryDiffSegment, MemoryFileSearchResult, MemoryFolder, MemoryRevisionSummary } from "../../api/types";
import DataTable, { type Column } from "../shared/DataTable.vue";
import ModalDialog from "../shared/ModalDialog.vue";
import MemoryInlineDiff from "./MemoryInlineDiff.vue";
import MemoryExplorerHeader from "./MemoryExplorerHeader.vue";

type DeletedMemory = { documentRef: string; folderId: string; fileName: string; revision: string; deletedAt: number };
type RecentRow = MemoryFileSearchResult & { id: string };
type TrashRow = DeletedMemory & { id: string; folderName: string; folderPath: string };
type VirtualRow = RecentRow | TrashRow;

const props = defineProps<{
  mode: "recent" | "trash";
  spaces: MemoryFolder[];
}>();

const emit = defineEmits<{
  home: [];
  restored: [];
}>();

const EXPLORER_VIEW_KEY = "cy-memory-explorer-view";
const savedView = localStorage.getItem(EXPLORER_VIEW_KEY);
const explorerView = ref<"list" | "grid">(savedView === "grid" ? "grid" : "list");
const loading = ref(false);
const error = ref("");
const recent = ref<RecentRow[]>([]);
const trash = ref<TrashRow[]>([]);
const query = ref("");
const restoringRef = ref("");
const deletingRef = ref("");
const pendingDelete = ref<TrashRow | null>(null);
const showEmptyConfirmation = ref(false);
const emptying = ref(false);
const diffDocument = ref<RecentRow | null>(null);
const diffRevision = ref<MemoryRevisionSummary | null>(null);
const diffSegments = ref<MemoryDiffSegment[]>([]);
const diffLoading = ref(false);
const diffError = ref("");

const title = computed(() => props.mode === "recent" ? "Recent documents" : "Trash");
const rootLabel = computed(() => {
  const root = props.spaces.find(folder => folder.isUncategorized) || props.spaces[0];
  const pathParts = root?.directoryPath.split(/[\\/]+/).filter(Boolean) || [];
  return pathParts.at(-1) || root?.name || "Memory";
});
const rows = computed<VirtualRow[]>(() => {
  const source: VirtualRow[] = props.mode === "recent" ? recent.value : trash.value;
  const term = query.value.trim().toLocaleLowerCase();
  return term ? source.filter((row) => row.fileName.toLocaleLowerCase().includes(term)) : source;
});

const columns = computed<Column<VirtualRow>[]>(() => [
  { key: "fileName", label: "Name", minWidth: "220px", grow: 3, sortable: true, sortValue: row => row.fileName },
  { key: "folderName", label: "Folder", minWidth: "160px", grow: 1.5, sortable: true, sortValue: row => row.folderPath || row.folderName },
  { key: "date", label: props.mode === "recent" ? "Modified" : "Deleted", minWidth: "140px", sortable: true, sortValue: row => "deletedAt" in row ? row.deletedAt : row.modifiedAt },
  { key: "actions", label: "Actions", minWidth: props.mode === "trash" ? "190px" : "100px", grow: 0 },
]);

function setExplorerView(view: "list" | "grid"): void {
  explorerView.value = view;
  localStorage.setItem(EXPLORER_VIEW_KEY, view);
}

function folderFor(folderId: string): MemoryFolder | undefined {
  return props.spaces.find(folder => folder.id === folderId);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    if (props.mode === "recent") {
      const groups = await Promise.all(props.spaces.map(async folder => ({
        folder,
        files: await api.memoryFolders.listFiles(folder.id),
      })));
      recent.value = groups.flatMap(({ folder, files }) => files.map(file => ({
        ...file,
        id: `${folder.id}\0${file.fileName}`,
        folderId: folder.id,
        folderName: folder.name,
        folderPath: folder.folderPath,
        matchedFields: [],
      }))).sort((a, b) => b.modifiedAt - a.modifiedAt || a.fileName.localeCompare(b.fileName));
    } else {
      const deleted = await api.memoryFolders.listDeleted();
      trash.value = deleted.map(memory => {
        const folder = folderFor(memory.folderId);
        return {
          ...memory,
          id: memory.documentRef,
          folderName: folder?.name || "Removed folder",
          folderPath: folder?.folderPath || "",
        };
      }).sort((a, b) => b.deletedAt - a.deletedAt);
    }
  } catch (cause) {
    error.value = (cause as Error).message || `Failed to load ${title.value.toLocaleLowerCase()}`;
  } finally {
    loading.value = false;
  }
}

async function open(row: VirtualRow): Promise<void> {
  if (props.mode !== "recent" || !("modifiedAt" in row) || !row.textDirect) return;
  diffDocument.value = row;
  diffRevision.value = null;
  diffSegments.value = [];
  diffError.value = "";
  diffLoading.value = true;
  try {
    const content = await api.memoryFolders.getFileContent(row.folderId, row.fileName);
    const targetDocumentRef = content.documentRef;
    if (!targetDocumentRef) throw new Error("This memory has no revision history.");
    const revisions = await api.memoryFolders.listRevisions(targetDocumentRef);
    const latest = revisions[0];
    const previous = revisions[1];
    if (!latest) throw new Error("This memory has no revision history.");
    diffRevision.value = latest;
    if (previous) {
      diffSegments.value = (await api.memoryFolders.getRevisionDiff(targetDocumentRef, previous.id, latest.id)).segments;
    } else {
      const revision = await api.memoryFolders.getRevision(targetDocumentRef, latest.id);
      diffSegments.value = revision.content ? [{ type: "added", text: revision.content }] : [];
    }
  } catch (cause) {
    diffError.value = (cause as Error).message || "Failed to load the latest change";
  } finally {
    diffLoading.value = false;
  }
}

async function restore(row: TrashRow): Promise<void> {
  restoringRef.value = row.documentRef;
  error.value = "";
  try {
    const revisions = await api.memoryFolders.listRevisions(row.documentRef);
    if (!revisions[0]) throw new Error("This memory has no restorable revision.");
    await api.memoryFolders.restoreRevision(row.documentRef, revisions[0].id, "");
    trash.value = trash.value.filter(item => item.documentRef !== row.documentRef);
    emit("restored");
  } catch (cause) {
    error.value = (cause as Error).message || "Failed to restore memory";
  } finally {
    restoringRef.value = "";
  }
}

async function permanentlyDelete(): Promise<void> {
  const row = pendingDelete.value;
  if (!row) return;
  deletingRef.value = row.documentRef;
  error.value = "";
  try {
    await api.memoryFolders.permanentlyDelete(row.documentRef);
    trash.value = trash.value.filter(item => item.documentRef !== row.documentRef);
    pendingDelete.value = null;
  } catch (cause) {
    error.value = (cause as Error).message || "Failed to permanently delete memory";
  } finally {
    deletingRef.value = "";
  }
}

async function emptyTrash(): Promise<void> {
  emptying.value = true;
  error.value = "";
  try {
    await api.memoryFolders.emptyTrash();
    trash.value = [];
    showEmptyConfirmation.value = false;
  } catch (cause) {
    error.value = (cause as Error).message || "Failed to empty trash";
  } finally {
    emptying.value = false;
  }
}

watch(() => props.mode, () => {
  query.value = "";
  void load();
});
onMounted(load);
</script>

<template>
  <div class="min-w-0">
    <MemoryExplorerHeader
      :segments="[{ label: rootLabel }, { label: title, disabled: true }]"
      can-go-back
      @home="emit('home')"
      @back="emit('home')"
      @segment-click="$event === 0 && emit('home')"
    >
      <template #actions>
        <button
          v-if="mode === 'trash' && trash.length"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-red-500/25 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10"
          @click="showEmptyConfirmation = true"
        >
          <Icon
            icon="lucide:trash-2"
            class="h-3.5 w-3.5"
          /> Empty trash
        </button>
      </template>
    </MemoryExplorerHeader>

    <div class="mb-3 flex items-center gap-2 rounded-lg border border-theme-800 bg-theme-950/30 p-2">
      <div class="relative min-w-0 flex-1">
        <Icon
          icon="lucide:search"
          class="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-500"
        />
        <input
          v-model="query"
          type="text"
          :placeholder="`Search ${title.toLocaleLowerCase()}…`"
          class="w-full rounded-lg border border-theme-800 bg-theme-900/60 py-2 pl-9 pr-3 text-sm text-theme-200 placeholder-theme-500 focus:border-theme-600 focus:outline-none"
        >
      </div>
      <div
        class="flex items-center rounded-lg border border-theme-800 bg-theme-900/60 p-0.5"
        aria-label="Explorer view"
      >
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md"
          :class="explorerView === 'list' ? 'bg-theme-700 text-theme-100' : 'text-theme-500'"
          aria-label="List view"
          @click="setExplorerView('list')"
        >
          <Icon
            icon="lucide:list"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md"
          :class="explorerView === 'grid' ? 'bg-theme-700 text-theme-100' : 'text-theme-500'"
          aria-label="Grid view"
          @click="setExplorerView('grid')"
        >
          <Icon
            icon="lucide:grid-2x2"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center text-theme-400 hover:text-theme-200"
        title="Refresh"
        @click="load"
      >
        <Icon
          :icon="loading ? 'lucide:loader-2' : 'lucide:refresh-cw'"
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': loading }"
        />
      </button>
    </div>

    <p
      v-if="error"
      class="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300"
    >
      {{ error }}
    </p>
    <div
      v-if="!loading && rows.length === 0"
      class="rounded-xl border border-theme-800 bg-theme-950/45 py-10 text-center text-sm text-theme-500"
    >
      {{ mode === 'recent' ? 'No documents yet.' : 'Trash is empty.' }}
    </div>

    <div
      v-else-if="explorerView === 'grid'"
      class="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3"
      data-testid="memory-virtual-grid"
    >
      <article
        v-for="row in rows"
        :key="row.id"
        class="group relative flex min-h-40 flex-col items-center justify-center rounded-xl border border-theme-800 bg-theme-950/45 p-4 text-center transition hover:border-theme-700 hover:bg-theme-800/30"
        :class="mode === 'recent' && 'cursor-pointer'"
        @click="open(row)"
      >
        <Icon
          :icon="mode === 'trash' ? 'lucide:file-x-2' : row.fileName.endsWith('.md') ? 'lucide:file-text' : 'lucide:file'"
          class="mb-3 h-10 w-10"
          :class="mode === 'trash' ? 'text-red-400' : 'text-theme-400'"
        />
        <span class="w-full truncate text-sm font-medium text-theme-200">{{ row.fileName }}</span>
        <span class="mt-1 w-full truncate text-[11px] text-theme-600">{{ row.folderName }}</span>
        <span class="mt-1 text-[11px] text-theme-500">{{ new Date('deletedAt' in row ? row.deletedAt : row.modifiedAt).toLocaleString() }}</span>
        <div class="mt-3 flex gap-2">
          <template v-if="mode === 'trash' && 'deletedAt' in row">
            <button
              class="rounded-lg bg-accent-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50"
              :disabled="restoringRef === row.documentRef"
              @click="restore(row)"
            >
              Restore
            </button>
            <button
              class="rounded-lg border border-red-500/25 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
              @click="pendingDelete = row"
            >
              Delete forever
            </button>
          </template>
          <button
            v-else
            class="rounded-lg border border-theme-700 px-2.5 py-1.5 text-xs text-theme-300 hover:bg-theme-800"
            @click.stop="open(row)"
          >
            Open
          </button>
        </div>
      </article>
    </div>

    <DataTable
      v-else-if="rows.length"
      :items="rows"
      :columns="columns"
      :selectable="false"
      :row-clickable="mode === 'recent'"
      :pagination="true"
      :page-size="30"
      pagination-position="both"
      :initial-sort-key="mode === 'recent' ? 'date' : 'date'"
      initial-sort-direction="desc"
      @row-click="open"
    >
      <template #col-fileName="{ item: row }">
        <div class="flex min-w-0 items-center gap-3">
          <Icon
            :icon="mode === 'trash' ? 'lucide:file-x-2' : 'lucide:file-text'"
            class="h-5 w-5 shrink-0"
            :class="mode === 'trash' ? 'text-red-400' : 'text-theme-400'"
          /><span class="truncate text-sm font-medium text-theme-200">{{ row.fileName }}</span>
        </div>
      </template>
      <template #col-folderName="{ item: row }">
        <span class="text-xs text-theme-400">{{ row.folderPath || row.folderName }}</span>
      </template>
      <template #col-date="{ item: row }">
        <span class="text-xs text-theme-500">{{ new Date('deletedAt' in row ? row.deletedAt : row.modifiedAt).toLocaleString() }}</span>
      </template>
      <template #col-actions="{ item: row }">
        <div
          class="flex gap-2"
          @click.stop
        >
          <template v-if="mode === 'trash' && 'deletedAt' in row">
            <button
              class="rounded px-2 py-1 text-xs text-accent-300 hover:bg-accent-500/10 disabled:opacity-50"
              :disabled="restoringRef === row.documentRef"
              @click="restore(row)"
            >
              Restore
            </button>
            <button
              class="rounded px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
              @click="pendingDelete = row"
            >
              Delete forever
            </button>
          </template>
          <button
            v-else
            class="rounded px-2 py-1 text-xs text-theme-300 hover:bg-theme-800"
            @click="open(row)"
          >
            Open
          </button>
        </div>
      </template>
    </DataTable>

    <ModalDialog
      :show="Boolean(diffDocument)"
      :title="diffDocument ? `Latest change to ${diffDocument.fileName.replace(/\.[^.]+$/, '')}` : 'Latest change'"
      icon="lucide:file-diff"
      icon-color="accent"
      max-width="max-w-4xl"
      max-height="h-[80vh]"
      body-overflow-hidden
      @close="diffDocument = null"
    >
      <div class="flex h-[60vh] min-h-0 flex-col">
        <div
          v-if="diffRevision"
          class="mb-3 flex shrink-0 flex-wrap items-center gap-2 text-xs text-theme-500"
        >
          <span>{{ folderFor(diffDocument?.folderId || '')?.name || 'Removed folder' }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ new Date(diffRevision.createdAt).toLocaleString() }}</span>
          <span aria-hidden="true">·</span>
          <span>Revision {{ diffRevision.revisionNumber }}</span>
        </div>
        <div
          v-if="diffLoading"
          class="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-theme-500"
        >
          <Icon
            icon="lucide:loader-2"
            class="h-4 w-4 animate-spin"
          /> Loading latest change…
        </div>
        <p
          v-else-if="diffError"
          class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {{ diffError }}
        </p>
        <MemoryInlineDiff
          v-else
          :segments="diffSegments"
          class="min-h-0 flex-1"
        />
      </div>
    </ModalDialog>

    <ModalDialog
      :show="Boolean(pendingDelete)"
      title="Permanently delete document?"
      icon="lucide:trash-2"
      icon-color="red"
      @close="pendingDelete = null"
    >
      <p class="leading-relaxed text-theme-400">
        Permanently delete <strong class="text-theme-200">{{ pendingDelete?.fileName }}</strong> and all revision history? This cannot be undone.
      </p>
      <template #actions>
        <button
          class="w-full rounded-xl bg-red-600 px-4 py-3 font-medium text-white hover:bg-red-500 disabled:opacity-50"
          :disabled="Boolean(deletingRef)"
          @click="permanentlyDelete"
        >
          Delete forever
        </button><button
          class="w-full rounded-xl bg-theme-800 px-4 py-3 font-medium text-theme-300 hover:bg-theme-700"
          @click="pendingDelete = null"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
    <ModalDialog
      :show="showEmptyConfirmation"
      title="Empty memory trash?"
      icon="lucide:trash-2"
      icon-color="red"
      @close="showEmptyConfirmation = false"
    >
      <p class="leading-relaxed text-theme-400">
        Permanently delete all {{ trash.length }} trashed documents and their revision history? This cannot be undone.
      </p>
      <template #actions>
        <button
          class="w-full rounded-xl bg-red-600 px-4 py-3 font-medium text-white hover:bg-red-500 disabled:opacity-50"
          :disabled="emptying"
          @click="emptyTrash"
        >
          {{ emptying ? 'Emptying…' : 'Empty trash permanently' }}
        </button><button
          class="w-full rounded-xl bg-theme-800 px-4 py-3 font-medium text-theme-300 hover:bg-theme-700"
          :disabled="emptying"
          @click="showEmptyConfirmation = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
