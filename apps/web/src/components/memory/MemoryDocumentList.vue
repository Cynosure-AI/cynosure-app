<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from "vue";
import { api } from "../../api/client";
import type { MemorySpace, MemoryFileStatus, MemoryIndexJob } from "../../api/types";
import { useMemoryJobsStore } from "../../stores/memory-jobs.store";
import { Icon } from "@iconify/vue";
import MemoryDocumentEditorModal from "./MemoryDocumentEditorModal.vue";
import DataTable, { type Column } from "../shared/DataTable.vue";
import ModalDialog from "../shared/ModalDialog.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";

interface DocumentDragPayload {
  sourceSpaceId: string;
  sourceFiles: string[];
}

type DocumentRow = MemoryFileStatus & { id: string };

const props = defineProps<{
  spaceId: string;
  spaces: MemorySpace[];
}>();

const memoryJobsStore = useMemoryJobsStore();

const emit = defineEmits<{
  editSpace: [];
  deleteSpace: [];
  spacesChanged: [];
}>();

// --- Constants ---
const FILES_PAGE_SIZE = 30;

// --- State ---
const files = ref<MemoryFileStatus[]>([]);
const filesLoading = ref(false);
const selectedFiles = ref<Set<string>>(new Set());
const deleting = ref(false);
const droppingIndexes = ref(false);
const moving = ref(false);
const showMoveDialog = ref(false);
const jobs = ref<MemoryIndexJob[]>([]);
const handledTerminalJobIds = ref<Set<string>>(new Set());
let jobsPollTimer: ReturnType<typeof setInterval> | null = null;

// Upload
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadProgress = ref({ current: 0, total: 0 });
const uploadResults = ref<{ fileName: string; chunks: number; error?: string }[]>([]);

// Search + pagination
const searchQuery = ref("");
const page = ref(0);
const visibleDocumentRows = ref<DocumentRow[]>([]);

const currentSpace = computed(() => props.spaces.find((s) => s.id === props.spaceId));

const filteredFiles = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return files.value;
  return files.value.filter((f) => f.fileName.toLowerCase().includes(q));
});

const documentRows = computed<DocumentRow[]>(() => filteredFiles.value.map((file) => ({ ...file, id: file.fileName })));

const selectedFileIds = computed({
  get: () => Array.from(selectedFiles.value),
  set: (value: string[]) => {
    selectedFiles.value = new Set(value);
  },
});

const columns: Column<DocumentRow>[] = [
  { key: "fileName", label: "File", width: "minmax(260px, 2fr)", sortable: true, sortValue: (file) => file.fileName },
  { key: "modifiedAt", label: "Modified", width: "140px", sortable: true, sortValue: (file) => file.modifiedAt },
  { key: "chunkCount", label: "Chunks", width: "96px", sortable: true, sortValue: (file) => file.chunkCount || 0 },
  { key: "entityIndexed", label: "Relationships", width: "120px", sortable: true, sortValue: (file) => file.entityIndexed },
  { key: "status", label: "Vector index", width: "160px", sortable: true, sortValue: (file) => file.status },
  { key: "actions", label: "Actions", width: "190px", class: "text-right" },
];

const allFilteredSelected = computed(
  () =>
    filteredFiles.value.length > 0 &&
    filteredFiles.value.every((f) => selectedFiles.value.has(f.fileName)),
);

const supportedFiles = computed(() => files.value.filter((f) => f.supported));
const needsAttentionCount = computed(
  () => supportedFiles.value.filter((f) => f.status === "needs_reindex" || f.status === "not_indexed").length,
);
const selectedEntityIndexableFiles = computed(() =>
  files.value.filter((f) => f.supported && f.status === "indexed" && selectedFiles.value.has(f.fileName)),
);
const selectedIndexedFiles = computed(() =>
  files.value.filter((f) =>
    f.supported &&
    f.status !== "not_indexed" &&
    selectedFiles.value.has(f.fileName),
  ),
);
const runningJobs = computed(() => jobs.value.filter((job) => job.status === "queued" || job.status === "running"));
const selectedEntityIndexableIdleCount = computed(() =>
  selectedEntityIndexableFiles.value.filter((f) => !isJobActive("entity-index", f.fileName)).length,
);

// --- Data loading ---
async function loadFiles() {
  filesLoading.value = true;
  try {
    files.value = await api.memorySpaces.listFiles(props.spaceId);
  } catch {
    files.value = [];
  }
  filesLoading.value = false;
}

function upsertJob(job: MemoryIndexJob) {
  const next = jobs.value.filter((item) => item.id !== job.id);
  next.push(job);
  jobs.value = next;
  memoryJobsStore.upsertJob(job);
  if (job.status === "queued" || job.status === "running") startJobsPolling();
}

function activeJob(kind: MemoryIndexJob["kind"], fileName: string): MemoryIndexJob | undefined {
  return jobs.value.find((job) =>
    job.kind === kind &&
    job.fileName === fileName &&
    (job.status === "queued" || job.status === "running"),
  );
}

function runningJob(kind: MemoryIndexJob["kind"], fileName: string): MemoryIndexJob | undefined {
  return activeJob(kind, fileName);
}

function isJobActive(kind: MemoryIndexJob["kind"], fileName: string): boolean {
  return Boolean(activeJob(kind, fileName));
}

function isJobRunning(kind: MemoryIndexJob["kind"], fileName: string): boolean {
  return isJobActive(kind, fileName);
}

async function applyTerminalJobs(nextJobs: MemoryIndexJob[]) {
  const seen = new Set(handledTerminalJobIds.value);
  const terminalJobs = nextJobs.filter((job) => job.status !== "queued" && job.status !== "running" && !seen.has(job.id));
  if (terminalJobs.length === 0) return;
  for (const job of terminalJobs) seen.add(job.id);
  handledTerminalJobIds.value = seen;
  await loadFiles();
  emit("spacesChanged");
}

async function loadJobs() {
  try {
    const nextJobs = await api.memorySpaces.listJobs(props.spaceId);
    jobs.value = nextJobs;
    await applyTerminalJobs(nextJobs);
    if (nextJobs.some((job) => job.status === "queued" || job.status === "running")) startJobsPolling();
    else stopJobsPolling();
  } catch {
    jobs.value = [];
    stopJobsPolling();
  }
}

function startJobsPolling() {
  if (jobsPollTimer) return;
  jobsPollTimer = setInterval(() => {
    void loadJobs();
  }, 2000);
}

function stopJobsPolling() {
  if (!jobsPollTimer) return;
  clearInterval(jobsPollTimer);
  jobsPollTimer = null;
}

function selectAllOnPage() {
  selectedFiles.value = new Set(visibleDocumentRows.value.filter((f) => f.supported).map((f) => f.fileName));
}

function selectAll() {
  selectedFiles.value = new Set(filteredFiles.value.filter((f) => f.supported).map((f) => f.fileName));
}

// --- Re-index ---
async function reindexFile(fileName: string) {
  try {
    upsertJob(await api.memorySpaces.startReindexFile(props.spaceId, fileName));
  } catch {
    /* error */
  }
}

// --- Entity graph indexing ---
async function entityIndexFile(fileName: string) {
  try {
    upsertJob(await api.memorySpaces.startEntityIndexFile(props.spaceId, fileName));
  } catch {
    /* error */
  }
}

async function entityIndexSelected() {
  for (const f of selectedEntityIndexableFiles.value) {
    if (!isJobActive("entity-index", f.fileName)) await entityIndexFile(f.fileName);
  }
}

async function reindexAll() {
  const toReindex = files.value.filter(
    (f) => f.supported && (f.status === "needs_reindex" || f.status === "not_indexed"),
  );
  for (const f of toReindex) {
    if (!isJobActive("reindex", f.fileName)) await reindexFile(f.fileName);
  }
}

async function cancelJob(job?: MemoryIndexJob) {
  if (!job) return;
  try {
    upsertJob(await api.memorySpaces.cancelJob(job.id));
    await loadFiles();
  } catch {
    /* ignore */
  }
}

// --- Bulk removal ---
async function deleteSelectedFiles() {
  if (selectedFiles.value.size === 0) return;
  deleting.value = true;
  try {
    await api.memorySpaces.deleteGroups(props.spaceId, Array.from(selectedFiles.value));
    const deleted = selectedFiles.value;
    selectedFiles.value = new Set();
    files.value = files.value.filter((f) => !deleted.has(f.fileName));
    emit("spacesChanged");
  } catch {
    /* error */
  }
  deleting.value = false;
}

async function dropSelectedIndexes() {
  const sourceFiles = selectedIndexedFiles.value.map((file) => file.fileName);
  if (sourceFiles.length === 0) return;
  droppingIndexes.value = true;
  try {
    await api.memorySpaces.dropIndexes(props.spaceId, sourceFiles);
    selectedFiles.value = new Set();
    await loadFiles();
    await loadJobs();
    emit("spacesChanged");
  } catch {
    /* error */
  }
  droppingIndexes.value = false;
}

// --- Move ---
async function moveSelectedFiles(targetSpaceId: string) {
  if (selectedFiles.value.size === 0 || targetSpaceId === props.spaceId) return;
  moving.value = true;
  try {
    await api.memorySpaces.moveGroups(props.spaceId, Array.from(selectedFiles.value), targetSpaceId);
    const moved = selectedFiles.value;
    selectedFiles.value = new Set();
    files.value = files.value.filter((f) => !moved.has(f.fileName));
    showMoveDialog.value = false;
    emit("spacesChanged");
  } catch {
    /* error */
  }
  moving.value = false;
}

async function moveGroupsToSpace(targetSpaceId: string, sourceFiles: string[]) {
  if (sourceFiles.length === 0 || targetSpaceId === props.spaceId) return;
  try {
    await api.memorySpaces.moveGroups(props.spaceId, sourceFiles, targetSpaceId);
    files.value = files.value.filter((f) => !sourceFiles.includes(f.fileName));
    emit("spacesChanged");
  } catch {
    /* error */
  }
}

// --- Upload ---
const PARSEABLE_DOC_EXTENSIONS = new Set([
  ".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods", ".pdf", ".rtf",
]);

function isParseableDoc(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return PARSEABLE_DOC_EXTENSIONS.has(ext);
}

function readFileContent(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (isParseableDoc(file.name)) {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    } else {
      file.text().then(resolve, reject);
    }
  });
}

async function handleFileUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = input.files;
  if (!files?.length) return;
  await ingestFiles(Array.from(files));
  input.value = "";
}

async function ingestFiles(fileList: File[]) {
  uploading.value = true;
  uploadResults.value = [];
  uploadProgress.value = { current: 0, total: fileList.length };
  const results: typeof uploadResults.value = [];

  for (const file of fileList) {
    uploadProgress.value.current++;
    if (file.size > 10 * 1024 * 1024) {
      results.push({ fileName: file.name, chunks: 0, error: "File too large (max 10MB)" });
      continue;
    }
    try {
      const content = await readFileContent(file);
      const res = await api.memorySpaces.ingestFile(props.spaceId, file.name, content);
      if (res.job) upsertJob(res.job);
      results.push({ fileName: res.fileName, chunks: res.chunksStored });
    } catch (err) {
      results.push({ fileName: file.name, chunks: 0, error: (err as Error).message });
    }
    uploadResults.value = [...results];
  }
  uploadResults.value = results;
  uploading.value = false;
  loadFiles();
  emit("spacesChanged");
}

const showEditorModal = ref(false);
const editorFileName = ref("");

function openEditorModal(fileName: string) {
  const file = files.value.find((f) => f.fileName === fileName);
  if (!file?.textDirect) return;
  editorFileName.value = fileName;
  showEditorModal.value = true;
}

async function handleEditorSaved() {
  showEditorModal.value = false;
  await loadFiles();
  await loadJobs();
  emit("spacesChanged");
}

// --- Drag ---
function startDocumentDrag(event: DragEvent, fileName: string) {
  const fileNames = selectedFiles.value.size > 0 ? Array.from(selectedFiles.value) : [fileName];
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(
    DOCUMENT_DRAG_MIME,
    JSON.stringify({ sourceSpaceId: props.spaceId, sourceFiles: fileNames } satisfies DocumentDragPayload),
  );
}

// --- Helpers ---
function statusIcon(status: MemoryFileStatus["status"]) {
  switch (status) {
    case "indexed": return "lucide:check-circle";
    case "needs_reindex": return "lucide:alert-circle";
    case "not_indexed": return "lucide:info";
    default: return "lucide:slash";
  }
}

function statusClass(status: MemoryFileStatus["status"]) {
  switch (status) {
    case "indexed": return "text-green-400";
    case "needs_reindex": return "text-orange-400";
    case "not_indexed": return "text-accent-400";
    default: return "text-theme-600";
  }
}

function statusLabel(status: MemoryFileStatus["status"]) {
  switch (status) {
    case "indexed": return "Vector indexed";
    case "needs_reindex": return "Needs vector re-index";
    case "not_indexed": return "Not vector indexed";
    default: return "Not supported";
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Lifecycle ---
watch(
  () => props.spaceId,
  () => {
    files.value = [];
    selectedFiles.value = new Set();
    jobs.value = [];
    handledTerminalJobIds.value = new Set();
    showEditorModal.value = false;
    editorFileName.value = "";
    searchQuery.value = "";
    page.value = 0;
    loadFiles();
    loadJobs();
  },
  { immediate: true },
);

onUnmounted(() => {
  stopJobsPolling();
});

defineExpose({ ingestFiles, moveGroupsToSpace });
</script>

<template>
  <div class="min-w-0">
    <!-- Folder header -->
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-2">
        <h2 class="text-lg font-medium text-theme-200">
          {{ currentSpace?.name }}
        </h2>
        <button
          type="button"
          class="p-1 text-theme-500 hover:text-theme-300 transition-colors"
          title="Edit folder"
          :aria-label="`Edit ${currentSpace?.name || 'folder'}`"
          @click="emit('editSpace')"
        >
          <Icon
            icon="lucide:pencil"
            class="w-3.5 h-3.5"
          />
        </button>
        <button
          type="button"
          :disabled="currentSpace?.isDefault"
          :title="currentSpace?.isDefault ? 'Cannot remove the default memory folder' : 'Remove folder'"
          :aria-label="currentSpace?.isDefault ? 'Default memory folder cannot be removed' : `Remove ${currentSpace?.name || 'folder'}`"
          class="p-1 text-theme-500 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-theme-500"
          @click="emit('deleteSpace')"
        >
          <Icon
            icon="lucide:trash-2"
            class="w-3.5 h-3.5"
          />
        </button>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="needsAttentionCount > 0"
          class="px-3 py-1.5 bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 rounded-lg text-sm transition-colors flex items-center gap-2"
          @click="reindexAll"
        >
          <Icon
            icon="lucide:refresh-cw"
            class="w-4 h-4"
          />
          Index vectors for {{ needsAttentionCount }}
        </button>
        <button
          :disabled="uploading"
          class="px-3 py-1.5 bg-theme-900/60 hover:bg-theme-800/60 border border-theme-800 text-theme-300 rounded-lg text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
          @click="fileInput?.click()"
        >
          <Icon
            :icon="uploading ? 'lucide:loader-2' : 'lucide:upload'"
            class="w-4 h-4"
            :class="{ 'animate-spin': uploading }"
          />
          Upload
        </button>
      </div>
    </div>

    <!-- Folder path hint -->
    <div
      v-if="currentSpace?.folderPath"
      class="mb-3 flex items-center gap-1.5 text-xs text-theme-600 min-w-0 overflow-hidden"
    >
      <Icon
        icon="lucide:folder"
        class="w-3.5 h-3.5 shrink-0"
      />

      <span class="truncate font-mono">{{ currentSpace.folderPath }}</span>
    </div>

    <!-- Upload progress -->
    <div
      v-if="uploading"
      class="mb-4 px-3 py-2 bg-accent-500/10 border border-accent-500/20 rounded-lg text-xs text-accent-300"
    >
      Uploading {{ uploadProgress.current }}/{{ uploadProgress.total }}…
    </div>

    <!-- Upload results -->
    <div
      v-if="uploadResults.length > 0"
      class="mb-4 space-y-1"
    >
      <div
        v-for="(r, i) in uploadResults"
        :key="i"
        class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
        :class="r.error ? 'bg-red-500/10 text-red-300' : 'bg-green-500/10 text-green-300'"
      >
        <Icon
          :icon="r.error ? 'lucide:x-circle' : 'lucide:check-circle'"
          class="w-3.5 h-3.5"
        />
        <span class="truncate">{{ r.fileName }}</span>
        <span
          v-if="!r.error"
          class="text-theme-500"
        >Uploaded, queued for indexing</span>
        <span
          v-else
          class="text-red-400"
        >{{ r.error }}</span>
      </div>
      <button
        class="text-xs text-theme-500 hover:text-theme-300 px-1"
        @click="uploadResults = []"
      >
        Clear
      </button>
    </div>

    <!-- Toolbar -->
    <div class="flex items-center justify-between mb-2">
      <div class="text-xs text-theme-500">
        {{ filteredFiles.length }} file{{ filteredFiles.length !== 1 ? "s" : "" }}
        <template v-if="runningJobs.length > 0">
          · {{ runningJobs.length }} job{{ runningJobs.length !== 1 ? "s" : "" }} active
        </template>
      </div>
      <div class="flex items-center gap-2">
        <template v-if="selectedFiles.size === 0 && files.length > 0">
          <button
            class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200"
            @click="selectAllOnPage"
          >
            Select page
          </button>
          <button
            class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200"
            @click="selectAll"
          >
            Select all {{ filteredFiles.length }}
          </button>
        </template>
        <button
          type="button"
          :disabled="filesLoading"
          class="px-2 py-1.5 text-xs text-theme-400 hover:text-theme-200"
          aria-label="Refresh documents"
          @click="loadFiles"
        >
          <Icon
            :icon="filesLoading ? 'lucide:loader-2' : 'lucide:refresh-cw'"
            class="w-3.5 h-3.5"
            :class="{ 'animate-spin': filesLoading }"
          />
        </button>
      </div>
    </div>

    <!-- Search -->
    <div
      v-if="files.length > 0"
      class="mb-3"
    >
      <div class="relative">
        <Icon
          icon="lucide:search"
          class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-500"
        />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search files…"
          class="w-full pl-9 pr-3 py-2 text-sm bg-theme-900/60 border border-theme-800 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-600 transition-colors"
          @input="page = 0"
        >
      </div>
    </div>

    <!-- Floating bulk actions: pinned inside the document area while scrolling. -->
    <div
      v-if="selectedFiles.size > 0"
      class="pointer-events-none sticky top-[calc(100vh_-_8rem)] z-30 h-0 sm:top-[calc(100vh_-_5.5rem)]"
    >
      <div class="pointer-events-auto mx-auto flex w-fit max-w-full items-center overflow-x-auto rounded-xl border border-theme-700/80 bg-theme-950/95 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <span class="shrink-0 border-r border-theme-800 px-3 text-xs font-medium text-theme-300">
          {{ selectedFiles.size }} selected
        </span>
        <button
          v-if="!allFilteredSelected"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-theme-400 transition-colors hover:bg-theme-800 hover:text-theme-200"
          @click="selectAll"
        >
          Select all {{ filteredFiles.length }}
        </button>
        <button
          v-if="spaces.length > 1"
          :disabled="moving"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-accent-400 transition-colors hover:bg-accent-500/10 disabled:opacity-50"
          @click="showMoveDialog = true"
        >
          <Icon
            :icon="moving ? 'lucide:loader-2' : 'lucide:folder-input'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': moving }"
          />
          Move
        </button>
        <button
          v-if="selectedEntityIndexableFiles.length > 0"
          :disabled="selectedEntityIndexableIdleCount === 0"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
          title="Extract entities and relationships from the selected vector-indexed documents"
          @click="entityIndexSelected"
        >
          <Icon
            :icon="selectedEntityIndexableIdleCount === 0 ? 'lucide:loader-2' : 'lucide:network'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': selectedEntityIndexableIdleCount === 0 }"
          />
          Extract relationships
        </button>
        <button
          v-if="selectedIndexedFiles.length > 0"
          :disabled="droppingIndexes"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-orange-400 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
          title="Remove vector and relationship indexes while keeping the source files"
          @click="dropSelectedIndexes"
        >
          <Icon
            :icon="droppingIndexes ? 'lucide:loader-2' : 'lucide:database-x'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': droppingIndexes }"
          />
          Remove indexes
        </button>
        <button
          :disabled="deleting"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
          title="Remove the selected source files and their indexes"
          @click="deleteSelectedFiles"
        >
          <Icon
            :icon="deleting ? 'lucide:loader-2' : 'lucide:trash-2'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': deleting }"
          />
          Remove
        </button>
        <button
          class="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-l border-theme-800 text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200"
          title="Clear selection"
          aria-label="Clear selection"
          @click="selectedFiles = new Set()"
        >
          <Icon
            icon="lucide:x"
            class="h-4 w-4"
          />
        </button>
      </div>
    </div>

    <!-- Empty states -->
    <div
      v-if="files.length === 0 && !filesLoading"
      class="rounded-xl border border-theme-800 bg-theme-950/45 text-center py-10 text-theme-500 text-sm"
    >
      No files in this folder yet. Upload files to get started.
    </div>
    <div
      v-else-if="filteredFiles.length === 0 && searchQuery.trim()"
      class="rounded-xl border border-theme-800 bg-theme-950/45 text-center py-10 text-theme-500 text-sm"
    >
      No files matching "{{ searchQuery.trim() }}"
    </div>

    <!-- File rows -->
    <DataTable
      v-else
      v-model:selected-ids="selectedFileIds"
      v-model:page="page"
      :items="documentRows"
      :columns="columns"
      :selectable="true"
      :row-selectable="(file) => file.supported"
      :row-clickable="true"
      :row-draggable="true"
      :row-class="(file) => !file.supported ? 'opacity-50' : file.textDirect ? 'cursor-pointer' : undefined"
      :pagination="true"
      :page-size="FILES_PAGE_SIZE"
      pagination-position="both"
      initial-sort-key="modifiedAt"
      initial-sort-direction="desc"
      :empty-message="searchQuery.trim() ? `No files matching '${searchQuery.trim()}'` : 'No files in this folder yet.'"
      @row-click="(file) => openEditorModal(file.fileName)"
      @row-dragstart="(file, event) => startDocumentDrag(event, file.fileName)"
      @visible-items-change="visibleDocumentRows = $event"
    >
      <template #col-fileName="{ item: file }">
        <div class="flex min-w-0 items-center gap-3">
          <Icon
            :icon="file.extension === '.md' ? 'lucide:file-text' : file.extension === '.pdf' ? 'lucide:file-type-2' : 'lucide:file'"
            class="h-4 w-4 shrink-0"
            :class="file.supported ? 'text-theme-400' : 'text-theme-600'"
          />
          <div class="min-w-0">
            <div
              class="truncate text-sm"
              :class="file.supported ? 'text-theme-200' : 'text-theme-500'"
            >
              {{ file.fileName }}
            </div>
            <div class="mt-0.5 flex items-center gap-2 text-[11px] text-theme-600">
              <span>{{ formatFileSize(file.size) }}</span>
            </div>
          </div>
        </div>
      </template>

      <template #col-modifiedAt="{ item: file }">
        <span class="text-xs text-theme-500">
          {{ new Date(file.modifiedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) }}
        </span>
      </template>

      <template #col-chunkCount="{ item: file }">
        <span
          v-if="file.supported && file.status === 'indexed'"
          class="text-xs text-theme-400"
        >
          {{ file.chunkCount || 0 }}
        </span>
        <span
          v-else
          class="text-xs text-theme-700"
        >
          —
        </span>
      </template>

      <template #col-entityIndexed="{ item: file }">
        <div
          v-if="file.supported"
          class="flex items-center"
          :title="file.entityIndexed ? 'Relationships extracted' : file.status === 'indexed' ? 'Relationships not extracted' : 'Relationship extraction requires a vector index first'"
        >
          <Icon
            :icon="file.entityIndexed ? 'lucide:network' : 'lucide:network-x'"
            class="h-3.5 w-3.5"
            :class="file.entityIndexed ? 'text-emerald-400' : 'text-theme-700'"
          />
        </div>
      </template>

      <template #col-status="{ item: file }">
        <div
          class="flex items-center gap-1.5"
          :title="statusLabel(file.status)"
        >
          <Icon
            :icon="statusIcon(file.status)"
            class="h-3.5 w-3.5"
            :class="statusClass(file.status)"
          />
          <span
            class="text-[11px]"
            :class="statusClass(file.status)"
          >
            {{ statusLabel(file.status) }}
          </span>
        </div>
      </template>

      <template #col-actions="{ item: file }">
        <div
          class="flex items-center justify-end gap-1"
          @click.stop
        >
          <button
            v-if="file.textDirect"
            class="p-1.5 text-theme-500 hover:text-accent-300 rounded-lg hover:bg-theme-800/70 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            title="Edit memory"
            @click="openEditorModal(file.fileName)"
          >
            <Icon
              icon="lucide:pencil"
              class="h-3.5 w-3.5"
            />
          </button>

          <button
            v-if="file.supported && (file.status === 'needs_reindex' || file.status === 'not_indexed')"
            class="flex items-center gap-1 rounded px-2 py-1 text-xs bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-colors disabled:opacity-50"
            :title="isJobRunning('reindex', file.fileName) ? 'Cancel vector indexing' : 'Build the vector index for this file'"
            @click="isJobRunning('reindex', file.fileName) ? cancelJob(runningJob('reindex', file.fileName)) : reindexFile(file.fileName)"
          >
            <Icon
              :icon="isJobRunning('reindex', file.fileName) ? 'lucide:loader-2' : 'lucide:refresh-cw'"
              class="h-3.5 w-3.5"
              :class="{ 'animate-spin': isJobRunning('reindex', file.fileName) }"
            />
            {{ isJobRunning("reindex", file.fileName) ? "Cancel" : "Index vectors" }}
          </button>

          <button
            v-else-if="file.supported && file.status === 'indexed'"
            class="p-1 text-theme-600 hover:text-theme-400 transition-colors opacity-0 group-hover:opacity-100"
            :class="{ 'opacity-100 text-orange-400 hover:text-orange-300': isJobRunning('reindex', file.fileName) }"
            :title="isJobRunning('reindex', file.fileName) ? 'Cancel vector indexing' : 'Rebuild vector index'"
            @click="isJobRunning('reindex', file.fileName) ? cancelJob(runningJob('reindex', file.fileName)) : reindexFile(file.fileName)"
          >
            <Icon
              :icon="isJobRunning('reindex', file.fileName) ? 'lucide:loader-2' : 'lucide:refresh-cw'"
              class="h-3.5 w-3.5"
              :class="{ 'animate-spin': isJobRunning('reindex', file.fileName) }"
            />
          </button>

          <button
            v-if="file.supported && file.status === 'indexed'"
            class="p-1 text-theme-600 hover:text-emerald-400 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
            :class="{ 'opacity-100 text-emerald-400': isJobRunning('entity-index', file.fileName) }"
            :title="isJobRunning('entity-index', file.fileName) ? 'Cancel relationship extraction' : 'Extract entities and relationships'"
            @click="isJobRunning('entity-index', file.fileName) ? cancelJob(runningJob('entity-index', file.fileName)) : entityIndexFile(file.fileName)"
          >
            <Icon
              :icon="isJobRunning('entity-index', file.fileName) ? 'lucide:loader-2' : 'lucide:network'"
              class="h-3.5 w-3.5"
              :class="{ 'animate-spin': isJobRunning('entity-index', file.fileName) }"
            />
          </button>
        </div>
      </template>
    </DataTable>

    <MemoryDocumentEditorModal
      :show="showEditorModal"
      :space-id="spaceId"
      :source-file="editorFileName"
      @close="showEditorModal = false"
      @saved="handleEditorSaved"
    />

    <!-- Hidden file input -->
    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.html,.htm,.toml,.ini,.cfg,.conf,.rst,.tex,.py,.js,.ts,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.r,.swift,.kt,.docx,.pptx,.xlsx,.odt,.odp,.ods,.pdf,.rtf"
      class="hidden"
      @change="handleFileUpload"
    >

    <!-- Move Dialog -->
    <ModalDialog
      :show="showMoveDialog"
      :title="`Move ${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''}`"
      icon="lucide:folder-input"
      max-width="max-w-2xl"
      max-height="max-h-[85vh]"
      @close="showMoveDialog = false"
    >
      <p class="mb-4 text-sm text-theme-500">
        Select the destination memory folder.
      </p>
      <div class="grid max-h-[55vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
        <button
          v-for="space in spaces.filter((s) => s.id !== spaceId)"
          :key="space.id"
          :disabled="moving"
          class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-theme-800 hover:border-accent-500/50 hover:bg-accent-500/5 transition-colors text-left disabled:opacity-50"
          @click="moveSelectedFiles(space.id)"
        >
          <Icon
            icon="lucide:folder"
            class="w-4 h-4 text-theme-400 shrink-0"
          />
          <div class="flex-1 min-w-0">
            <div class="text-sm text-theme-200 truncate">
              {{ space.name }}
            </div>
            <div class="text-xs text-theme-500">
              {{ space.fileCount }} file{{ space.fileCount !== 1 ? "s" : "" }}
            </div>
          </div>
          <Icon
            :icon="moving ? 'lucide:loader-2' : 'lucide:chevron-right'"
            class="w-4 h-4 text-theme-600 shrink-0"
            :class="{ 'animate-spin': moving }"
          />
        </button>
      </div>
      <template #actions>
        <button
          class="w-full rounded-xl bg-theme-800 px-4 py-3 text-center text-sm font-medium text-theme-300 transition-colors hover:bg-theme-700"
          @click="showMoveDialog = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
