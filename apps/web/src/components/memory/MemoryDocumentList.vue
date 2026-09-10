<script setup lang="ts">
import { ref, computed, onUnmounted, toRef, watch } from "vue";
import { api } from "../../api/client";
import type { MemorySpace, MemoryFileStatus, MemoryDocumentKnowledgePreview } from "../../api/types";
import { Icon } from "@iconify/vue";
import MemoryDocumentEditorModal from "./MemoryDocumentEditorModal.vue";
import DataTable, { type Column } from "../shared/DataTable.vue";
import HoverTooltip from "../shared/HoverTooltip.vue";
import { useMemoryDocumentJobs } from "../../composables/useMemoryDocumentJobs";
import MemoryDocumentMoveDialog from "./MemoryDocumentMoveDialog.vue";

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
const forgettingMemories = ref(false);
const moving = ref(false);
const showMoveDialog = ref(false);
const knowledgePreviews = ref<Record<string, { status: "loading" | "ready" | "error"; data?: MemoryDocumentKnowledgePreview }>>({});
const unsubscribeGraphReset = api.memory.onGraphReset(() => {
  knowledgePreviews.value = {};
  files.value = files.value.map((file) => ({
    ...file,
    knowledgeExtracted: false,
    knowledgeExtractedAt: undefined,
  }));
  void loadFiles();
});

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
  return files.value.filter((f) =>
    f.fileName.toLowerCase().includes(q) || (f.tags || []).some((tag) => tag.includes(q)),
  );
});

const documentRows = computed<DocumentRow[]>(() => filteredFiles.value.map((file) => ({ ...file, id: file.fileName })));

const selectedFileIds = computed({
  get: () => Array.from(selectedFiles.value),
  set: (value: string[]) => {
    selectedFiles.value = new Set(value);
  },
});

const columns: Column<DocumentRow>[] = [
  { key: "fileName", label: "File", minWidth: "220px", grow: 3, sortable: true, sortValue: (file) => file.fileName },
  { key: "modifiedAt", label: "Modified", minWidth: "104px", sortable: true, sortValue: (file) => file.modifiedAt },
  { key: "chunkCount", label: "Chunks", minWidth: "70px", grow: 0, sortable: true, sortValue: (file) => file.chunkCount || 0 },
  { key: "knowledgeExtracted", label: "Analysed", minWidth: "190px", sortable: true, sortValue: (file) => file.knowledgeExtracted },
  { key: "status", label: "Searchable", minWidth: "220px", grow: 1.15, sortable: true, sortValue: (file) => file.status },
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
const selectedKnowledgeExtractableFiles = computed(() =>
  files.value.filter((f) => f.supported && f.status === "indexed" && selectedFiles.value.has(f.fileName)),
);
const selectedRememberedFiles = computed(() =>
  files.value.filter((f) =>
    f.supported &&
    (f.status !== "not_indexed" || f.knowledgeExtracted) &&
    selectedFiles.value.has(f.fileName),
  ),
);
const selectedKnowledgeExtractableIdleCount = computed(() =>
  selectedKnowledgeExtractableFiles.value.filter((f) => !isJobActive("knowledge-extraction", f.fileName)).length,
);

// --- Data loading ---
async function loadFiles() {
  filesLoading.value = true;
  knowledgePreviews.value = {};
  try {
    files.value = await api.memorySpaces.listFiles(props.spaceId);
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
  upsertJob,
  loadJobs,
  reindexFile,
  extractKnowledgeFromFile,
  reindexAll,
  cancelJob,
  reset: resetJobs,
  entityExtractionProgress,
  searchIndexProgress,
} = useMemoryDocumentJobs({
  spaceId: toRef(props, "spaceId"),
  files,
  reloadFiles: loadFiles,
  onCompleted: () => emit("spacesChanged"),
});

async function knowledgeExtractionSelected(): Promise<void> {
  for (const file of selectedKnowledgeExtractableFiles.value) {
    if (!isJobActive("knowledge-extraction", file.fileName)) await extractKnowledgeFromFile(file.fileName);
  }
}

async function loadKnowledgePreview(fileName: string) {
  if (knowledgePreviews.value[fileName]) return;
  knowledgePreviews.value = {
    ...knowledgePreviews.value,
    [fileName]: { status: "loading" },
  };
  try {
    const data = await api.memorySpaces.getDocumentKnowledgePreview(props.spaceId, fileName);
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

async function forgetSelectedMemories() {
  const sourceFiles = selectedRememberedFiles.value.map((file) => file.fileName);
  if (sourceFiles.length === 0) return;
  forgettingMemories.value = true;
  try {
    await api.memorySpaces.forgetMemories(props.spaceId, sourceFiles);
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
  () => props.spaceId,
  () => {
    files.value = [];
    knowledgePreviews.value = {};
    selectedFiles.value = new Set();
    resetJobs();
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
  unsubscribeGraphReset();
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
          v-if="selectedKnowledgeExtractableFiles.length > 0"
          :disabled="selectedKnowledgeExtractableIdleCount === 0"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
          title="Extract and classify facts from the selected searchable documents"
          @click="knowledgeExtractionSelected"
        >
          <Icon
            :icon="selectedKnowledgeExtractableIdleCount === 0 ? 'lucide:loader-2' : 'lucide:network'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': selectedKnowledgeExtractableIdleCount === 0 }"
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
          Forget Memories
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
          v-else
          class="text-xs text-theme-700"
        >
          —
        </span>
      </template>

      <template #col-knowledgeExtracted="{ item: file }">
        <div
          v-if="file.supported"
          class="flex items-center gap-1.5"
          :title="!isJobRunning('knowledge-extraction', file.fileName) && !file.knowledgeExtracted ? (file.status === 'indexed' ? 'Facts not extracted' : 'Fact extraction requires a search index first') : undefined"
        >
          <button
            v-if="isJobRunning('knowledge-extraction', file.fileName)"
            type="button"
            class="job-cancel-control inline-flex items-center rounded-md px-2 py-1 text-[11px] text-accent-400 transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:bg-red-500/10 focus-visible:text-red-400"
            title="Cancel fact extraction"
            @click.stop="cancelJob(runningJob('knowledge-extraction', file.fileName))"
          >
            <span class="job-progress inline-flex items-center gap-1.5">
              <Icon
                icon="lucide:loader-2"
                class="h-3.5 w-3.5 animate-spin"
              />
              {{ entityExtractionProgress(file.fileName) }}
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
            v-if="!isJobRunning('knowledge-extraction', file.fileName) && file.knowledgeExtracted"
            :max-width="380"
            @show="loadKnowledgePreview(file.fileName)"
          >
            <span class="inline-flex overflow-hidden rounded-md border border-green-500/15 bg-green-500/5">
              <span class="inline-flex cursor-help items-center gap-1.5 px-2 py-1 text-[11px] text-green-400">
                <Icon
                  icon="lucide:check-circle"
                  class="h-3.5 w-3.5"
                />
                Analysed
              </span>
              <button
                type="button"
                class="inline-flex items-center border-l border-green-500/15 px-1.5 text-green-500 transition-colors hover:bg-accent-500/10 hover:text-accent-300"
                title="Analyse this document again"
                aria-label="Analyse this document again"
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
          <span
            v-if="!isJobRunning('knowledge-extraction', file.fileName) && !file.knowledgeExtracted && file.status !== 'indexed'"
            class="inline-flex items-center gap-1.5 rounded-md border border-theme-700/60 bg-theme-900/40 px-2 py-1 text-[11px] text-theme-500"
          >
            <Icon
              icon="lucide:circle-dashed"
              class="h-3.5 w-3.5"
            />
            Not analysed
          </span>
          <button
            v-if="!isJobRunning('knowledge-extraction', file.fileName) && !file.knowledgeExtracted && file.status === 'indexed'"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-accent-500/15 bg-accent-500/10 px-2 py-1 text-[11px] text-accent-300 transition-colors hover:bg-accent-500/20"
            title="Extract and classify facts from this document"
            @click.stop="extractKnowledgeFromFile(file.fileName)"
          >
            <Icon
              icon="lucide:network"
              class="h-3.5 w-3.5"
            />
            Analyse
          </button>
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

    <MemoryDocumentMoveDialog
      :show="showMoveDialog"
      :source-space-id="spaceId"
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
