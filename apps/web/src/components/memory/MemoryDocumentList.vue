<script setup lang="ts">
import { ref, computed, onUnmounted, toRef, watch } from "vue";
import { api } from "../../api/client";
import type { MemoryFolder, MemoryFileStatus, MemoryFileSearchResult, MemoryDocumentKnowledgePreview, MemoryIndexJob } from "../../api/types";
import { Icon } from "@iconify/vue";
import MemoryDocumentEditorModal from "./MemoryDocumentEditorModal.vue";
import DataTable, { type Column } from "../shared/DataTable.vue";
import HoverTooltip from "../shared/HoverTooltip.vue";
import SplitButton from "../shared/SplitButton.vue";
import { useMemoryDocumentJobs } from "../../composables/useMemoryDocumentJobs";
import MemoryDocumentMoveDialog from "./MemoryDocumentMoveDialog.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";

interface DocumentDragPayload {
  sourceCategoryId: string;
  sourceFiles: string[];
}

type DocumentRow = MemoryFileStatus & { id: string };
type GlobalDocumentRow = MemoryFileSearchResult & { id: string };

const props = defineProps<{
  categoryId: string;
  spaces: MemoryFolder[];
  focusFile?: string;
}>();

const emit = defineEmits<{
  editSpace: [];
  deleteSpace: [];
  spacesChanged: [];
  documentDragState: [active: boolean, payload?: DocumentDragPayload];
  openGlobalDocument: [categoryId: string, fileName: string];
}>();

// --- Constants ---
const FILES_PAGE_SIZE = 30;
const MAX_ANALYSIS_CHUNKS = 10;

function supportsAnalysis(file: MemoryFileStatus): boolean {
  return file.status === "indexed" && (file.chunkCount || 0) <= MAX_ANALYSIS_CHUNKS;
}

// --- State ---
const files = ref<MemoryFileStatus[]>([]);
const filesLoading = ref(false);
const selectedFiles = ref<Set<string>>(new Set());
const deleting = ref(false);
const forgettingMemories = ref(false);
const moving = ref(false);
const showMoveDialog = ref(false);
const knowledgePreviews = ref<Record<string, { status: "loading" | "ready" | "error"; data?: MemoryDocumentKnowledgePreview }>>({});
const unsubscribeGraphReset = api.memory.onGraphReset(() => {
  knowledgePreviews.value = {};
  files.value = files.value.map((file) => ({
    ...file,
    deepResearched: false,
    analysisStatus: "not_analyzed",
    deepResearchedAt: undefined,
  }));
  void loadFiles();
});
const unsubscribeDreamUpdate = api.memory.onDreamUpdated(() => void loadFiles());
const DREAM_INDICATOR_DURATION_MS = 2 * 24 * 60 * 60 * 1000;
const dreamIndicatorNow = ref(Date.now());
const dreamIndicatorTimer = window.setInterval(() => {
  dreamIndicatorNow.value = Date.now();
}, 60_000);

function hasRecentDreamUpdate(file: MemoryFileStatus): boolean {
  return Boolean(file.dreamedAt && dreamIndicatorNow.value - file.dreamedAt < DREAM_INDICATOR_DURATION_MS);
}

// Upload
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadProgress = ref({ current: 0, total: 0 });
const uploadResults = ref<{ fileName: string; chunks: number; error?: string }[]>([]);

// Search + pagination
const searchQuery = ref("");
const page = ref(0);
const visibleDocumentRows = ref<DocumentRow[]>([]);
const globalSearchResults = ref<MemoryFileSearchResult[]>([]);
const globalSearchLoading = ref(false);
let globalSearchTimer: number | null = null;
let globalSearchSequence = 0;

const currentSpace = computed(() => props.spaces.find((s) => s.id === props.categoryId));

const filteredFiles = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return files.value;
  return files.value.filter((f) =>
    f.fileName.toLowerCase().includes(q) || (f.tags || []).some((tag) => tag.includes(q)),
  );
});

const documentRows = computed<DocumentRow[]>(() => filteredFiles.value.map((file) => ({ ...file, id: file.fileName })));
const globalDocumentRows = computed<GlobalDocumentRow[]>(() => globalSearchResults.value.map((file) => ({
  ...file,
  id: `${file.categoryId}\0${file.fileName}`,
})));

const selectedFileIds = computed({
  get: () => Array.from(selectedFiles.value),
  set: (value: string[]) => {
    selectedFiles.value = new Set(value);
  },
});

const columns: Column<DocumentRow>[] = [
  { key: "fileName", label: "File", minWidth: "220px", grow: 3, sortable: true, sortValue: (file) => file.fileName },
  { key: "modifiedAt", label: "Modified", minWidth: "104px", sortable: true, sortValue: (file) => file.modifiedAt },
  { key: "chunkCount", label: "Chunks", minWidth: "70px", grow: 0, sortable: true, sortValue: (file) => file.status === "indexed" ? (file.chunkCount || 0) : (file.estimatedChunkCount || 0) },
  { key: "deepResearched", label: "Deep Research", minWidth: "190px", sortable: true, sortValue: (file) => file.deepResearched },
  { key: "status", label: "Searchable", minWidth: "220px", grow: 1.15, sortable: true, sortValue: (file) => file.status },
];

const globalColumns: Column<GlobalDocumentRow>[] = [
  { key: "fileName", label: "File", minWidth: "220px", grow: 3, sortable: true, sortValue: (file) => file.fileName },
  { key: "categoryName", label: "Folder", minWidth: "150px", grow: 1.5, sortable: true, sortValue: (file) => file.categoryPath || file.categoryName },
  { key: "modifiedAt", label: "Modified", minWidth: "104px", sortable: true, sortValue: (file) => file.modifiedAt },
  { key: "status", label: "Searchable", minWidth: "150px", grow: 1, sortable: true, sortValue: (file) => file.status },
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
const selectedDeepResearchFiles = computed(() =>
  files.value.filter((f) => f.supported && supportsAnalysis(f) && selectedFiles.value.has(f.fileName)),
);
const selectedRememberedFiles = computed(() =>
  files.value.filter((f) =>
    f.supported &&
    (f.status !== "not_indexed" || f.deepResearched) &&
    selectedFiles.value.has(f.fileName),
  ),
);
const selectedDeepResearchIdleCount = computed(() =>
  selectedDeepResearchFiles.value.filter((f) => !isJobActive("deep-research", f.fileName)).length,
);
const selectedSearchIndexFiles = computed(() =>
  files.value.filter((file) =>
    file.supported &&
    (file.status === "needs_reindex" || file.status === "not_indexed") &&
    selectedFiles.value.has(file.fileName),
  ),
);
const selectedSearchIndexIdleCount = computed(() =>
  selectedSearchIndexFiles.value.filter((file) => !isJobActive("reindex", file.fileName)).length,
);

// --- Data loading ---
async function loadFiles() {
  filesLoading.value = true;
  knowledgePreviews.value = {};
  try {
    files.value = await api.memoryFolders.listFiles(props.categoryId);
  } catch {
    files.value = [];
  }
  filesLoading.value = false;
}

const {
  runningJobs,
  activeJob: runningJob,
  isJobActive,
  isJobRunning,
  resumableJob,
  failedJobs,
  dismissFailure,
  dismissAllFailures,
  upsertJob,
  loadJobs,
  reindexFile,
  extractKnowledgeFromFile,
  reindexAll,
  cancelJob,
  discardJob,
  reset: resetJobs,
  deepResearchProgress,
  searchIndexProgress,
} = useMemoryDocumentJobs({
  categoryId: toRef(props, "categoryId"),
  files,
  reloadFiles: loadFiles,
  onCompleted: () => emit("spacesChanged"),
});

function jobKindLabel(kind: MemoryIndexJob["kind"]): string {
  if (kind === "deep-research") return "Deep Research";
  if (kind === "tool-embeddings") return "Tool indexing";
  return "Search indexing";
}

async function deepResearchSelected(): Promise<void> {
  for (const file of selectedDeepResearchFiles.value) {
    if (!isJobActive("deep-research", file.fileName)) await extractKnowledgeFromFile(file.fileName);
  }
}

async function makeSearchableSelected(): Promise<void> {
  for (const file of selectedSearchIndexFiles.value) {
    if (!isJobActive("reindex", file.fileName)) await reindexFile(file.fileName);
  }
}

async function loadKnowledgePreview(fileName: string) {
  if (knowledgePreviews.value[fileName]) return;
  knowledgePreviews.value = {
    ...knowledgePreviews.value,
    [fileName]: { status: "loading" },
  };
  try {
    const data = await api.memoryFolders.getDocumentKnowledgePreview(props.categoryId, fileName);
    knowledgePreviews.value = {
      ...knowledgePreviews.value,
      [fileName]: { status: "ready", data },
    };
  } catch {
    knowledgePreviews.value = {
      ...knowledgePreviews.value,
      [fileName]: { status: "error" },
    };
  }
}

function selectAllOnPage() {
  selectedFiles.value = new Set(visibleDocumentRows.value.filter((f) => f.supported).map((f) => f.fileName));
}

function selectAll() {
  selectedFiles.value = new Set(filteredFiles.value.filter((f) => f.supported).map((f) => f.fileName));
}

// --- Bulk removal ---
async function deleteSelectedFiles() {
  if (selectedFiles.value.size === 0) return;
  deleting.value = true;
  try {
    await api.memoryFolders.deleteDocuments(props.categoryId, Array.from(selectedFiles.value));
    const deleted = selectedFiles.value;
    selectedFiles.value = new Set();
    files.value = files.value.filter((f) => !deleted.has(f.fileName));
    emit("spacesChanged");
  } catch {
    /* error */
  }
  deleting.value = false;
}

async function forgetSelectedMemories() {
  const sourceFiles = selectedRememberedFiles.value.map((file) => file.fileName);
  if (sourceFiles.length === 0) return;
  forgettingMemories.value = true;
  try {
    await api.memoryFolders.forgetMemories(props.categoryId, sourceFiles);
    selectedFiles.value = new Set();
    await loadFiles();
    await loadJobs();
    emit("spacesChanged");
  } catch {
    /* error */
  }
  forgettingMemories.value = false;
}

// --- Move ---
async function moveSelectedFiles(targetCategoryId: string) {
  if (selectedFiles.value.size === 0 || targetCategoryId === props.categoryId) return;
  moving.value = true;
  try {
    await api.memoryFolders.moveDocuments(props.categoryId, Array.from(selectedFiles.value), targetCategoryId);
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

async function moveDocumentsToCategory(targetCategoryId: string, sourceFiles: string[]) {
  if (sourceFiles.length === 0 || targetCategoryId === props.categoryId) return;
  try {
    await api.memoryFolders.moveDocuments(props.categoryId, sourceFiles, targetCategoryId);
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
      const res = await api.memoryFolders.ingestFile(props.categoryId, file.name, content);
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

function openDocument(fileName: string) {
  editorFileName.value = fileName;
  showEditorModal.value = true;
}

function openGlobalResult(file: GlobalDocumentRow) {
  if (!file.textDirect) return;
  emit("openGlobalDocument", file.categoryId, file.fileName);
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
  const payload = { sourceCategoryId: props.categoryId, sourceFiles: fileNames } satisfies DocumentDragPayload;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DOCUMENT_DRAG_MIME, JSON.stringify(payload));
  event.dataTransfer.setData("text/plain", JSON.stringify(payload));
  emit("documentDragState", true, payload);
}

function endDocumentDrag() {
  emit("documentDragState", false);
}

// --- Helpers ---
function statusIcon(status: MemoryFileStatus["status"]) {
  switch (status) {
    case "indexed": return "lucide:check-circle";
    case "needs_reindex": return "lucide:alert-circle";
    case "not_indexed": return "lucide:circle-dashed";
    default: return "lucide:slash";
  }
}

function statusLabel(status: MemoryFileStatus["status"]) {
  switch (status) {
    case "indexed": return "Searchable";
    case "needs_reindex": return "Update needed";
    case "not_indexed": return "Not searchable";
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
  () => props.categoryId,
  () => {
    files.value = [];
    knowledgePreviews.value = {};
    selectedFiles.value = new Set();
    resetJobs();
    showEditorModal.value = false;
    editorFileName.value = "";
    searchQuery.value = props.focusFile || "";
    page.value = 0;
    loadFiles();
    loadJobs();
  },
  { immediate: true },
);

watch(() => props.focusFile, (fileName, previousFileName) => {
  if (!fileName && !previousFileName) return;
  searchQuery.value = fileName || "";
  page.value = 0;
});

watch(searchQuery, (query) => {
  page.value = 0;
  if (globalSearchTimer !== null) window.clearTimeout(globalSearchTimer);
  const trimmed = query.trim();
  const sequence = ++globalSearchSequence;
  if (!trimmed) {
    globalSearchResults.value = [];
    globalSearchLoading.value = false;
    return;
  }
  selectedFiles.value = new Set();
  globalSearchLoading.value = true;
  globalSearchTimer = window.setTimeout(async () => {
    try {
      const results = await api.memoryFolders.searchFiles(trimmed);
      if (sequence === globalSearchSequence) globalSearchResults.value = results;
    } catch {
      if (sequence === globalSearchSequence) globalSearchResults.value = [];
    } finally {
      if (sequence === globalSearchSequence) globalSearchLoading.value = false;
    }
  }, 200);
});

onUnmounted(() => {
  if (globalSearchTimer !== null) window.clearTimeout(globalSearchTimer);
  window.clearInterval(dreamIndicatorTimer);
  unsubscribeGraphReset();
  unsubscribeDreamUpdate();
});

defineExpose({ ingestFiles, moveDocumentsToCategory, openDocument });
</script>

<template>
  <div class="memory-document-list min-w-0">
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
          :disabled="currentSpace?.isUncategorized"
          :title="currentSpace?.isUncategorized ? 'Cannot remove Uncategorized' : 'Remove folder'"
          :aria-label="currentSpace?.isUncategorized ? 'Uncategorized memory cannot be removed' : `Remove ${currentSpace?.name || 'folder'}`"
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
          Search-index {{ needsAttentionCount }}
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

    <!-- Folder description -->
    <p
      v-if="currentSpace?.description"
      class="mb-3 text-sm text-theme-500"
    >
      {{ currentSpace.description }}
    </p>
    <p
      v-else
      class="mb-3 text-sm text-theme-600 italic"
    >
      No description set
    </p>

    <!-- Folder path hint -->
    <div
      v-if="currentSpace?.directoryPath"
      class="mb-3 flex items-center gap-1.5 text-xs text-theme-600 min-w-0 overflow-hidden"
    >
      <Icon
        icon="lucide:folder"
        class="w-3.5 h-3.5 shrink-0"
      />

      <span class="truncate font-mono">{{ currentSpace.directoryPath }}</span>
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
        >Uploaded — indexing is manual</span>
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

    <!-- Background job failures. Jobs run server-side, so a failure would
         otherwise be invisible once the job stops being "active". -->
    <div
      v-if="failedJobs.length > 0"
      class="mb-4 space-y-1"
    >
      <div
        v-for="job in failedJobs"
        :key="job.id"
        class="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"
      >
        <Icon
          icon="lucide:circle-alert"
          class="mt-0.5 h-3.5 w-3.5 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <div class="font-medium">
            {{ jobKindLabel(job.kind) }} failed for {{ job.fileName }}
          </div>
          <div class="mt-0.5 break-words text-red-400/80">
            {{ job.error || "Unknown error" }}
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 rounded px-1.5 py-0.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-200"
          title="Dismiss"
          aria-label="Dismiss failure"
          @click="dismissFailure(job.id)"
        >
          <Icon
            icon="lucide:x"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
      <button
        v-if="failedJobs.length > 1"
        type="button"
        class="px-1 text-xs text-theme-500 transition-colors hover:text-theme-300"
        @click="dismissAllFailures"
      >
        Clear all
      </button>
    </div>

    <!-- Toolbar -->
    <div class="flex items-center justify-between mb-2">
      <div class="text-xs text-theme-500">
        <template v-if="searchQuery.trim()">
          {{ globalSearchResults.length }} result{{ globalSearchResults.length !== 1 ? "s" : "" }} across all folders
        </template>
        <template v-else>
          {{ files.length }} file{{ files.length !== 1 ? "s" : "" }}
        </template>
        <template v-if="runningJobs.length > 0">
          · {{ runningJobs.length }} job{{ runningJobs.length !== 1 ? "s" : "" }} active
        </template>
      </div>
      <div class="flex items-center gap-2">
        <template v-if="!searchQuery.trim() && selectedFiles.size === 0 && files.length > 0">
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
    <div class="mb-3">
      <div class="relative">
        <Icon
          icon="lucide:search"
          class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-500"
        />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search files…"
          class="w-full py-2 pl-9 pr-9 text-sm bg-theme-900/60 border border-theme-800 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-600 transition-colors"
          @input="page = 0"
        >
        <Icon
          v-if="globalSearchLoading"
          icon="lucide:loader-2"
          class="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-theme-500"
        />
      </div>
    </div>

    <!-- Floating bulk actions: pinned inside the document area while scrolling. -->
    <div
      v-if="!searchQuery.trim() && selectedFiles.size > 0"
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
          v-if="selectedSearchIndexFiles.length > 0"
          :disabled="selectedSearchIndexIdleCount === 0"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-orange-400 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
          title="Build or refresh semantic search vectors for the selected documents"
          @click="makeSearchableSelected"
        >
          <Icon
            :icon="selectedSearchIndexIdleCount === 0 ? 'lucide:loader-2' : 'lucide:search-check'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': selectedSearchIndexIdleCount === 0 }"
          />
          Make searchable ({{ selectedSearchIndexFiles.length }})
        </button>
        <button
          v-if="selectedDeepResearchFiles.length > 0"
          :disabled="selectedDeepResearchIdleCount === 0"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
          title="Extract and classify facts from the selected searchable documents"
          @click="deepResearchSelected"
        >
          <Icon
            :icon="selectedDeepResearchIdleCount === 0 ? 'lucide:loader-2' : 'lucide:network'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': selectedDeepResearchIdleCount === 0 }"
          />
          Extract facts
        </button>
        <button
          v-if="selectedRememberedFiles.length > 0"
          :disabled="forgettingMemories"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-orange-400 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
          title="Remove semantic search vectors and extracted facts while keeping the source files"
          @click="forgetSelectedMemories"
        >
          <Icon
            :icon="forgettingMemories ? 'lucide:loader-2' : 'lucide:brain-circuit'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': forgettingMemories }"
          />
          Drop Index
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

    <!-- Global cross-folder search results -->
    <DataTable
      v-if="searchQuery.trim()"
      v-model:page="page"
      :items="globalDocumentRows"
      :columns="globalColumns"
      :selectable="false"
      :row-clickable="true"
      :row-class="(file) => !file.textDirect ? 'opacity-60' : 'cursor-pointer'"
      :pagination="true"
      :page-size="FILES_PAGE_SIZE"
      pagination-position="both"
      :empty-message="globalSearchLoading ? 'Searching all folders…' : `No files matching '${searchQuery.trim()}'`"
      @row-click="openGlobalResult"
    >
      <template #col-fileName="{ item: file }">
        <div class="flex min-w-0 items-center gap-3">
          <Icon
            :icon="file.extension === '.md' ? 'lucide:file-text' : file.extension === '.pdf' ? 'lucide:file-type-2' : 'lucide:file'"
            class="h-4 w-4 shrink-0 text-theme-400"
          />
          <div class="min-w-0">
            <div class="truncate text-sm text-theme-200">
              {{ file.fileName }}
            </div>
            <div class="mt-0.5 flex flex-wrap gap-1">
              <span
                v-for="field in file.matchedFields"
                :key="field"
                class="rounded border border-theme-700/80 bg-theme-900/70 px-1.5 py-0.5 text-[10px] text-theme-500"
              >{{ field }}</span>
            </div>
          </div>
        </div>
      </template>
      <template #col-categoryName="{ item: file }">
        <div class="min-w-0 text-xs text-theme-400">
          <div class="truncate">
            {{ file.categoryName }}
          </div>
          <div
            v-if="file.categoryPath"
            class="truncate text-[10px] text-theme-600"
          >
            {{ file.categoryPath }}
          </div>
        </div>
      </template>
      <template #col-modifiedAt="{ item: file }">
        <span class="text-xs text-theme-500">{{ new Date(file.modifiedAt).toLocaleDateString() }}</span>
      </template>
      <template #col-status="{ item: file }">
        <span
          class="inline-flex items-center gap-1.5 text-xs"
          :class="file.status === 'indexed' ? 'text-green-400' : 'text-theme-500'"
        >
          <Icon
            :icon="statusIcon(file.status)"
            class="h-3.5 w-3.5"
          />
          {{ statusLabel(file.status) }}
        </span>
      </template>
    </DataTable>

    <!-- Empty states -->
    <div
      v-else-if="files.length === 0 && !filesLoading"
      class="rounded-xl border border-theme-800 bg-theme-950/45 text-center py-10 text-theme-500 text-sm"
    >
      No files in this folder yet. Upload files to get started.
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
      empty-message="No files in this folder yet."
      @row-click="(file) => openEditorModal(file.fileName)"
      @row-dragstart="(file, event) => startDocumentDrag(event, file.fileName)"
      @row-dragend="endDocumentDrag"
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
              class="flex items-center gap-1.5 truncate text-sm"
              :class="hasRecentDreamUpdate(file) ? 'text-violet-400' : file.supported ? 'text-theme-200' : 'text-theme-500'"
            >
              <Icon
                v-if="hasRecentDreamUpdate(file)"
                icon="lucide:moon-star"
                class="h-3.5 w-3.5 shrink-0"
                title="Created or updated by Dream in the last 2 days"
                aria-label="Created or updated by Dream in the last 2 days"
              />
              <span class="truncate">{{ file.fileName }}</span>
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-theme-600">
              <span>{{ formatFileSize(file.size) }}</span>
              <span
                v-for="tag in (file.tags || []).slice(0, 4)"
                :key="tag"
                class="rounded border border-theme-700/80 bg-theme-900/70 px-1.5 py-0.5 text-[10px] text-theme-400"
              >{{ tag }}</span>
              <span
                v-if="(file.tags || []).length > 4"
                :title="(file.tags || []).slice(4).join(', ')"
                class="text-[10px] text-theme-500"
              >+{{ (file.tags || []).length - 4 }}</span>
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
          v-else-if="file.supported && file.estimatedChunkCount !== undefined"
          class="text-xs text-theme-600"
          title="Estimated from file size and current chunking settings"
        >
          ~{{ file.estimatedChunkCount }}
        </span>
        <span
          v-else
          class="text-xs text-theme-700"
        >
          —
        </span>
      </template>

      <template #col-deepResearched="{ item: file }">
        <div
          v-if="file.supported"
          class="flex items-center gap-1.5"
          :title="!isJobRunning('deep-research', file.fileName) && !file.deepResearched ? (file.status === 'indexed' ? (file.analysisStatus === 'needs_refresh' ? 'Analysis needs to be refreshed' : 'Facts not extracted') : 'Deep Research requires a search index first') : undefined"
        >
          <button
            v-if="isJobRunning('deep-research', file.fileName)"
            type="button"
            class="job-cancel-control inline-flex items-center rounded-md px-2 py-1 text-[11px] text-accent-400 transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:bg-red-500/10 focus-visible:text-red-400"
            title="Cancel Deep Research"
            @click.stop="cancelJob(runningJob('deep-research', file.fileName))"
          >
            <span class="job-progress inline-flex items-center gap-1.5">
              <Icon
                icon="lucide:loader-2"
                class="h-3.5 w-3.5 animate-spin"
              />
              {{ deepResearchProgress(file.fileName) }}
            </span>
            <span class="job-cancel items-center gap-1.5 font-medium">
              <Icon
                icon="lucide:x"
                class="h-3.5 w-3.5"
              />
              Cancel
            </span>
          </button>
          <HoverTooltip
            v-if="!isJobRunning('deep-research', file.fileName) && !resumableJob(file.fileName) && file.deepResearched"
            :max-width="380"
            @show="loadKnowledgePreview(file.fileName)"
          >
            <span class="inline-flex overflow-hidden rounded-md border border-green-500/15 bg-green-500/5">
              <span class="inline-flex cursor-help items-center gap-1.5 px-2 py-1 text-[11px] text-green-400">
                <Icon
                  icon="lucide:check-circle"
                  class="h-3.5 w-3.5"
                />
                Deep Research
              </span>
              <button
                v-if="supportsAnalysis(file)"
                type="button"
                class="inline-flex items-center border-l border-green-500/15 px-1.5 text-green-500 transition-colors hover:bg-accent-500/10 hover:text-accent-300"
                title="Run Deep Research again"
                aria-label="Run Deep Research again"
                @click.stop="extractKnowledgeFromFile(file.fileName)"
              >
                <Icon
                  icon="lucide:refresh-cw"
                  class="h-3.5 w-3.5"
                />
              </button>
            </span>
            <template #content>
              <div class="w-[340px] max-w-full">
                <div class="mb-2 font-medium text-theme-200">
                  Extracted information
                </div>
                <div
                  v-if="knowledgePreviews[file.fileName]?.status === 'loading'"
                  class="flex items-center gap-2 text-theme-500"
                >
                  <Icon
                    icon="lucide:loader-2"
                    class="h-3.5 w-3.5 animate-spin"
                  />
                  Loading…
                </div>
                <div
                  v-else-if="knowledgePreviews[file.fileName]?.status === 'error'"
                  class="text-red-400"
                >
                  Could not load extracted information.
                </div>
                <div
                  v-else-if="knowledgePreviews[file.fileName]?.data?.items.length"
                  class="space-y-1.5"
                >
                  <div
                    v-for="(item, index) in knowledgePreviews[file.fileName]?.data?.items"
                    :key="`${item.kind}-${index}-${item.label}`"
                    class="flex items-start gap-2 text-theme-300"
                  >
                    <Icon
                      :icon="item.kind === 'relationship' ? 'lucide:git-branch' : 'lucide:user-round'"
                      class="mt-0.5 h-3 w-3 shrink-0 text-theme-500"
                    />
                    <span class="break-words">{{ item.label }}</span>
                  </div>
                  <div
                    v-if="(knowledgePreviews[file.fileName]?.data?.total || 0) > 15"
                    class="pt-1 text-theme-500"
                  >
                    +{{ (knowledgePreviews[file.fileName]?.data?.total || 0) - 15 }} more
                  </div>
                </div>
                <div
                  v-else
                  class="text-theme-500"
                >
                  No durable knowledge was extracted.
                </div>
              </div>
            </template>
          </HoverTooltip>
          <SplitButton
            v-if="!isJobRunning('deep-research', file.fileName) && supportsAnalysis(file) && resumableJob(file.fileName)"
            :primary-label="`Resume Deep Research of ${file.fileName}`"
            :menu-label="`Deep Research options for ${file.fileName}`"
            title="Continue running Deep Research on the remaining document parts"
            placement="above"
            @primary="extractKnowledgeFromFile(file.fileName)"
          >
            <Icon
              icon="lucide:play"
              class="h-3.5 w-3.5"
            />
            <span class="text-[11px] font-medium">
              Resume {{ resumableJob(file.fileName)?.progressCurrent }}/{{ resumableJob(file.fileName)?.progressTotal }}
            </span>
            <template #menu="{ close }">
              <button
                type="button"
                class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-red-300 transition-colors hover:bg-red-500/10 focus:outline-none focus-visible:bg-red-500/10"
                role="menuitem"
                @click.stop="close(); discardJob(resumableJob(file.fileName))"
              >
                <Icon
                  icon="lucide:x"
                  class="mt-0.5 h-4 w-4 shrink-0"
                />
                <span>
                  <span class="block text-xs font-medium">Cancel</span>
                  <span class="mt-0.5 block text-[11px] leading-4 text-theme-400">Discard saved Deep Research progress and start over next time.</span>
                </span>
              </button>
            </template>
          </SplitButton>
          <span
            v-if="!isJobRunning('deep-research', file.fileName) && !file.deepResearched && file.status !== 'indexed'"
            class="inline-flex items-center gap-1.5 rounded-md border border-theme-700/60 bg-theme-900/40 px-2 py-1 text-[11px] text-theme-500"
          >
            <Icon
              icon="lucide:circle-dashed"
              class="h-3.5 w-3.5"
            />
            Not researched
          </span>
          <button
            v-if="!isJobRunning('deep-research', file.fileName) && !resumableJob(file.fileName) && !file.deepResearched && supportsAnalysis(file)"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-accent-500/15 bg-accent-500/10 px-2 py-1 text-[11px] text-accent-300 transition-colors hover:bg-accent-500/20"
            title="Extract and classify facts from this document"
            @click.stop="extractKnowledgeFromFile(file.fileName)"
          >
            <Icon
              :icon="file.analysisStatus === 'needs_refresh' ? 'lucide:refresh-cw' : 'lucide:network'"
              class="h-3.5 w-3.5"
            />
            {{ file.analysisStatus === 'needs_refresh' ? 'Refresh analysis' : 'Run Deep Research' }}
          </button>
          <span
            v-if="!isJobRunning('deep-research', file.fileName) && file.status === 'indexed' && (file.chunkCount || 0) > MAX_ANALYSIS_CHUNKS"
            class="inline-flex items-center gap-1.5 rounded-md border border-theme-700/60 bg-theme-900/40 px-2 py-1 text-[11px] text-theme-500"
            :title="`Analysis is limited to ${MAX_ANALYSIS_CHUNKS} chunks; this document has ${file.chunkCount}.`"
          >
            <Icon icon="lucide:ban" class="h-3.5 w-3.5" />
            Too large to analyze
          </span>
        </div>
      </template>

      <template #col-status="{ item: file }">
        <button
          v-if="file.supported && isJobRunning('reindex', file.fileName)"
          type="button"
          class="job-cancel-control inline-flex items-center rounded-md px-2 py-1 text-[11px] text-accent-400 transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:bg-red-500/10 focus-visible:text-red-400"
          title="Cancel search indexing"
          @click.stop="cancelJob(runningJob('reindex', file.fileName))"
        >
          <span class="job-progress inline-flex items-center gap-1.5">
            <Icon
              icon="lucide:loader-2"
              class="h-3.5 w-3.5 animate-spin"
            />
            {{ searchIndexProgress(file.fileName) }}
          </span>
          <span class="job-cancel items-center gap-1.5 font-medium">
            <Icon
              icon="lucide:x"
              class="h-3.5 w-3.5"
            />
            Cancel
          </span>
        </button>
        <div
          v-else
          class="flex items-center gap-1.5"
          :title="statusLabel(file.status)"
        >
          <div
            v-if="file.status === 'indexed'"
            class="inline-flex overflow-hidden rounded-md border border-green-500/15 bg-green-500/5"
          >
            <span class="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] text-green-400">
              <Icon
                icon="lucide:check-circle"
                class="h-3.5 w-3.5"
              />
              Searchable
            </span>
            <button
              type="button"
              class="inline-flex items-center border-l border-green-500/15 px-1.5 text-green-500 transition-colors hover:bg-accent-500/10 hover:text-accent-300"
              title="Re-index semantic search vectors"
              aria-label="Re-index semantic search vectors"
              @click.stop="reindexFile(file.fileName)"
            >
              <Icon
                icon="lucide:refresh-cw"
                class="h-3.5 w-3.5"
              />
            </button>
          </div>
          <button
            v-else-if="file.supported"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors"
            :class="file.status === 'needs_reindex' ? 'border-orange-500/15 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20' : 'border-accent-500/15 bg-accent-500/10 text-accent-300 hover:bg-accent-500/20'"
            :title="file.status === 'needs_reindex' ? 'Re-index semantic search vectors' : 'Build semantic search vectors for this document'"
            @click.stop="reindexFile(file.fileName)"
          >
            <Icon
              :icon="statusIcon(file.status)"
              class="h-3.5 w-3.5"
            />
            <span v-if="file.status === 'needs_reindex'">Re-index</span>
            <span v-else>Make searchable</span>
          </button>
          <span
            v-else
            class="inline-flex items-center gap-1.5 rounded-md border border-theme-700/60 bg-theme-900/40 px-2 py-1 text-[11px] text-theme-600"
          >
            <Icon
              icon="lucide:slash"
              class="h-3.5 w-3.5"
            />
            Not supported
          </span>
        </div>
      </template>
    </DataTable>

    <MemoryDocumentEditorModal
      :show="showEditorModal"
      :category-id="categoryId"
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

    <MemoryDocumentMoveDialog
      :show="showMoveDialog"
      :source-category-id="categoryId"
      :selected-count="selectedFiles.size"
      :spaces="spaces"
      :moving="moving"
      @close="showMoveDialog = false"
      @move="moveSelectedFiles"
    />
  </div>
</template>

<style scoped>
.job-cancel {
  display: none;
}

.job-cancel-control:hover .job-progress,
.job-cancel-control:focus-visible .job-progress {
  display: none;
}

.job-cancel-control:hover .job-cancel,
.job-cancel-control:focus-visible .job-cancel {
  display: inline-flex;
}
</style>
