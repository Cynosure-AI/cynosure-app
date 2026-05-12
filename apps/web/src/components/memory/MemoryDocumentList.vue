<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { api } from "../../api/client";
import type { MemorySpace, MemoryFileStatus } from "../../api/types";
import { Icon } from "@iconify/vue";
import MemoryDocumentModal from "./MemoryDocumentModal.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";

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
const moving = ref(false);
const showMoveDialog = ref(false);
const reindexingFile = ref<string | null>(null);

// Upload
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadProgress = ref({ current: 0, total: 0 });
const uploadResults = ref<{ fileName: string; chunks: number; error?: string }[]>([]);

// Search + pagination
const searchQuery = ref("");
const page = ref(0);

const currentSpace = computed(() => props.spaces.find((s) => s.id === props.spaceId));

const filteredFiles = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return files.value;
  return files.value.filter((f) => f.fileName.toLowerCase().includes(q));
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredFiles.value.length / FILES_PAGE_SIZE)));

const pagedFiles = computed(() => {
  const start = page.value * FILES_PAGE_SIZE;
  return filteredFiles.value.slice(start, start + FILES_PAGE_SIZE);
});

const allFilteredSelected = computed(
  () =>
    filteredFiles.value.length > 0 &&
    filteredFiles.value.every((f) => selectedFiles.value.has(f.fileName)),
);

const supportedFiles = computed(() => files.value.filter((f) => f.supported));
const needsAttentionCount = computed(
  () => supportedFiles.value.filter((f) => f.status === "needs_reindex" || f.status === "not_indexed").length,
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

// --- Selection ---
function toggleSelectFile(fileName: string) {
  const s = new Set(selectedFiles.value);
  if (s.has(fileName)) s.delete(fileName);
  else s.add(fileName);
  selectedFiles.value = s;
}

function selectAllOnPage() {
  selectedFiles.value = new Set(pagedFiles.value.filter((f) => f.supported).map((f) => f.fileName));
}

function selectAll() {
  selectedFiles.value = new Set(filteredFiles.value.filter((f) => f.supported).map((f) => f.fileName));
}

// --- Re-index ---
async function reindexFile(fileName: string) {
  reindexingFile.value = fileName;
  try {
    const res = await api.memorySpaces.reindexFile(props.spaceId, fileName);
    if (res.success) {
      const idx = files.value.findIndex((f) => f.fileName === fileName);
      if (idx !== -1) {
        files.value[idx] = {
          ...files.value[idx],
          status: "indexed",
          chunkCount: res.chunksStored,
          lastIndexedAt: Date.now(),
        };
      }
    }
  } catch {
    /* error */
  }
  reindexingFile.value = null;
}

async function reindexAll() {
  const toReindex = files.value.filter(
    (f) => f.supported && (f.status === "needs_reindex" || f.status === "not_indexed"),
  );
  for (const f of toReindex) {
    await reindexFile(f.fileName);
  }
}

// --- Bulk delete ---
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

// --- Document preview modal ---
interface MemoryEntry {
  id: string; text: string; source: string; tags?: string;
  sourceFile?: string; chunkIndex?: number; createdAt: number;
}

const showDocumentModal = ref(false);
const modalFileName = ref("");
const fileChunks = ref<Map<string, MemoryEntry[]>>(new Map());
const fileChunksLoading = ref<Set<string>>(new Set());

async function loadFileChunks(fileName: string) {
  if (fileChunks.value.has(fileName) || fileChunksLoading.value.has(fileName)) return;
  const loading = new Set(fileChunksLoading.value);
  loading.add(fileName);
  fileChunksLoading.value = loading;
  try {
    const entries = await api.memorySpaces.listEntries(props.spaceId, fileName);
    const newMap = new Map(fileChunks.value);
    newMap.set(fileName, entries as MemoryEntry[]);
    fileChunks.value = newMap;
  } catch {
    /* ignore */
  } finally {
    const l = new Set(fileChunksLoading.value);
    l.delete(fileName);
    fileChunksLoading.value = l;
  }
}

function openDocumentModal(fileName: string) {
  if (!files.value.find((f) => f.fileName === fileName)?.supported) return;
  modalFileName.value = fileName;
  showDocumentModal.value = true;
  loadFileChunks(fileName);
}

function onChunkUpdated(chunkId: string, newText: string) {
  const chunks = fileChunks.value.get(modalFileName.value);
  if (!chunks) return;
  const newMap = new Map(fileChunks.value);
  newMap.set(modalFileName.value, chunks.map((c) => (c.id === chunkId ? { ...c, text: newText } : c)));
  fileChunks.value = newMap;
}

// --- Drag ---
function startDocumentDrag(event: DragEvent, fileName: string) {
  const fileNames = selectedFiles.value.size > 0 ? Array.from(selectedFiles.value) : [fileName];
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DOCUMENT_DRAG_MIME, JSON.stringify({ sourceFiles: fileNames }));
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
    case "not_indexed": return "text-blue-400";
    default: return "text-zinc-600";
  }
}

function statusLabel(status: MemoryFileStatus["status"]) {
  switch (status) {
    case "indexed": return "Indexed";
    case "needs_reindex": return "Needs re-index";
    case "not_indexed": return "Not indexed";
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
    fileChunks.value = new Map();
    showDocumentModal.value = false;
    modalFileName.value = "";
    searchQuery.value = "";
    page.value = 0;
    loadFiles();
  },
  { immediate: true },
);

defineExpose({ ingestFiles, moveGroupsToSpace });
</script>

<template>
  <div>
    <!-- Space header -->
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-2">
        <h2 class="text-lg font-medium text-zinc-200">
          {{ currentSpace?.name }}
        </h2>
        <button
          class="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Edit space"
          @click="emit('editSpace')"
        >
          <Icon
            icon="lucide:pencil"
            class="w-3.5 h-3.5"
          />
        </button>
        <button
          :disabled="currentSpace?.isDefault"
          :title="currentSpace?.isDefault ? 'Cannot delete the default memory space' : 'Delete space'"
          class="p-1 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-500"
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
          Re-index {{ needsAttentionCount }}
        </button>
        <button
          :disabled="uploading"
          class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
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
      class="mb-3 flex items-center gap-1.5 text-xs text-zinc-600"
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
      class="mb-4 px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-300"
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
          class="text-zinc-500"
        >{{ r.chunks }} chunks</span>
        <span
          v-else
          class="text-red-400"
        >{{ r.error }}</span>
      </div>
      <button
        class="text-xs text-zinc-500 hover:text-zinc-300 px-1"
        @click="uploadResults = []"
      >
        Clear
      </button>
    </div>

    <!-- Toolbar -->
    <div class="flex items-center justify-between mb-2">
      <div class="text-xs text-zinc-500">
        {{ filteredFiles.length }} file{{ filteredFiles.length !== 1 ? "s" : "" }}
      </div>
      <div class="flex items-center gap-2">
        <template v-if="selectedFiles.size > 0">
          <button
            class="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            @click="selectedFiles = new Set()"
          >
            Clear
          </button>
          <button
            v-if="!allFilteredSelected"
            class="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            @click="selectAll"
          >
            Select all {{ filteredFiles.length }}
          </button>
          <button
            v-if="spaces.length > 1"
            :disabled="moving"
            class="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded transition-colors"
            @click="showMoveDialog = true"
          >
            <Icon
              :icon="moving ? 'lucide:loader-2' : 'lucide:move-right'"
              class="w-3.5 h-3.5"
              :class="{ 'animate-spin': moving }"
            />
            Move {{ selectedFiles.size }}
          </button>
          <button
            :disabled="deleting"
            class="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded transition-colors"
            @click="deleteSelectedFiles"
          >
            <Icon
              :icon="deleting ? 'lucide:loader-2' : 'lucide:trash-2'"
              class="w-3.5 h-3.5"
              :class="{ 'animate-spin': deleting }"
            />
            Delete {{ selectedFiles.size }}
          </button>
        </template>
        <template v-else-if="files.length > 0">
          <button
            class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            @click="selectAllOnPage"
          >
            Select page
          </button>
          <button
            class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            @click="selectAll"
          >
            Select all {{ filteredFiles.length }}
          </button>
        </template>
        <button
          :disabled="filesLoading"
          class="px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
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
          class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500"
        />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search files…"
          class="w-full pl-9 pr-3 py-2 text-sm bg-zinc-800/60 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
          @input="page = 0"
        >
      </div>
    </div>

    <!-- Empty states -->
    <div
      v-if="files.length === 0 && !filesLoading"
      class="text-center py-8 text-zinc-500 text-sm"
    >
      No files in this space yet. Upload files to get started.
    </div>
    <div
      v-else-if="filteredFiles.length === 0 && searchQuery.trim()"
      class="text-center py-8 text-zinc-500 text-sm"
    >
      No files matching "{{ searchQuery.trim() }}"
    </div>

    <!-- File rows -->
    <div
      v-else
      class="space-y-1.5"
    >
      <!-- Top pagination -->
      <div
        v-if="totalPages > 1"
        class="flex items-center justify-center gap-2 mb-2"
      >
        <button
          :disabled="page === 0"
          class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
          @click="page = Math.max(0, page - 1)"
        >
          Prev
        </button>
        <span class="text-xs text-zinc-500">{{ page + 1 }} / {{ totalPages }}</span>
        <button
          :disabled="page >= totalPages - 1"
          class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
          @click="page = Math.min(totalPages - 1, page + 1)"
        >
          Next
        </button>
      </div>

      <div
        v-for="file in pagedFiles"
        :key="file.fileName"
        draggable="true"
        class="group/row flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/40 transition-colors"
        :class="{ 'opacity-50': !file.supported, 'cursor-pointer': file.supported }"
        @click="openDocumentModal(file.fileName)"
        @dragstart.stop="startDocumentDrag($event, file.fileName)"
      >
        <input
          v-if="file.supported"
          type="checkbox"
          class="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500/30"
          :checked="selectedFiles.has(file.fileName)"
          @click.stop
          @change.stop.prevent="toggleSelectFile(file.fileName)"
        >
        <div
          v-else
          class="w-4 h-4 shrink-0"
        />

        <!-- File type icon -->
        <Icon
          :icon="file.extension === '.md' ? 'lucide:file-text' : file.extension === '.pdf' ? 'lucide:file-type-2' : 'lucide:file'"
          class="w-4 h-4 shrink-0"
          :class="file.supported ? 'text-zinc-400' : 'text-zinc-600'"
        />

        <!-- Name + meta -->
        <div class="flex-1 min-w-0">
          <div
            class="text-sm truncate"
            :class="file.supported ? 'text-zinc-200' : 'text-zinc-500'"
          >
            {{ file.fileName }}
          </div>
          <div class="text-[11px] text-zinc-600 flex items-center gap-2 mt-0.5">
            <span>{{ formatFileSize(file.size) }}</span>
            <span>·</span>
            <span>{{ new Date(file.modifiedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) }}</span>
            <template v-if="file.supported && file.status === 'indexed' && file.chunkCount">
              <span>·</span>
              <span>{{ file.chunkCount }} chunk{{ file.chunkCount !== 1 ? "s" : "" }}</span>
            </template>
          </div>
        </div>

        <!-- Status indicator -->
        <div
          class="flex items-center gap-1.5 shrink-0"
          :title="statusLabel(file.status)"
        >
          <Icon
            :icon="statusIcon(file.status)"
            class="w-3.5 h-3.5"
            :class="statusClass(file.status)"
          />
          <span
            class="text-[11px] hidden sm:inline"
            :class="statusClass(file.status)"
          >
            {{ statusLabel(file.status) }}
          </span>
        </div>

        <!-- Re-index button -->
        <button
          v-if="file.supported && (file.status === 'needs_reindex' || file.status === 'not_indexed')"
          :disabled="reindexingFile === file.fileName"
          class="shrink-0 flex items-center gap-1 px-2 py-1 text-xs bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 rounded transition-colors disabled:opacity-50"
          title="Re-index this file"
          @click.stop="reindexFile(file.fileName)"
        >
          <Icon
            :icon="reindexingFile === file.fileName ? 'lucide:loader-2' : 'lucide:refresh-cw'"
            class="w-3.5 h-3.5"
            :class="{ 'animate-spin': reindexingFile === file.fileName }"
          />
          Re-index
        </button>

        <!-- Re-index complete icon (idle state for indexed) — only shown on hover -->
        <button
          v-else-if="file.supported && file.status === 'indexed'"
          class="shrink-0 p-1 text-zinc-600 hover:text-zinc-400 transition-colors opacity-0 group-hover/row:opacity-100"
          title="Force re-index"
          :disabled="reindexingFile === file.fileName"
          @click.stop="reindexFile(file.fileName)"
        >
          <Icon
            :icon="reindexingFile === file.fileName ? 'lucide:loader-2' : 'lucide:refresh-cw'"
            class="w-3.5 h-3.5"
            :class="{ 'animate-spin': reindexingFile === file.fileName }"
          />
        </button>
      </div>

      <!-- Bottom pagination -->
      <div
        v-if="totalPages > 1"
        class="flex items-center justify-center gap-2 mt-4"
      >
        <button
          :disabled="page === 0"
          class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
          @click="page = Math.max(0, page - 1)"
        >
          Prev
        </button>
        <span class="text-xs text-zinc-500">{{ page + 1 }} / {{ totalPages }}</span>
        <button
          :disabled="page >= totalPages - 1"
          class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
          @click="page = Math.min(totalPages - 1, page + 1)"
        >
          Next
        </button>
      </div>
    </div>

    <!-- Document Viewer Modal -->
    <MemoryDocumentModal
      :show="showDocumentModal"
      :space-id="spaceId"
      :source-file="modalFileName"
      :chunk-count="files.find((f) => f.fileName === modalFileName)?.chunkCount ?? 0"
      :chunks="fileChunks.get(modalFileName) ?? []"
      :loading="fileChunksLoading.has(modalFileName)"
      @close="showDocumentModal = false"
      @chunk-updated="onChunkUpdated"
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
    <Teleport to="body">
      <div
        v-if="showMoveDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="showMoveDialog = false"
      >
        <div class="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-xl">
          <h3 class="text-base font-medium text-zinc-200 mb-2">
            Move {{ selectedFiles.size }} file{{ selectedFiles.size !== 1 ? "s" : "" }}
          </h3>
          <p class="text-sm text-zinc-500 mb-4">
            Select the target memory space:
          </p>
          <div class="space-y-2 max-h-60 overflow-y-auto">
            <button
              v-for="space in spaces.filter((s) => s.id !== spaceId)"
              :key="space.id"
              :disabled="moving"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-800 hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors text-left disabled:opacity-50"
              @click="moveSelectedFiles(space.id)"
            >
              <Icon
                icon="lucide:database"
                class="w-4 h-4 text-zinc-400 shrink-0"
              />
              <div class="flex-1 min-w-0">
                <div class="text-sm text-zinc-200 truncate">
                  {{ space.name }}
                </div>
                <div class="text-xs text-zinc-500">
                  {{ space.fileCount }} file{{ space.fileCount !== 1 ? "s" : "" }}
                </div>
              </div>
              <Icon
                :icon="moving ? 'lucide:loader-2' : 'lucide:chevron-right'"
                class="w-4 h-4 text-zinc-600 shrink-0"
                :class="{ 'animate-spin': moving }"
              />
            </button>
          </div>
          <div class="flex justify-end mt-4">
            <button
              class="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
              @click="showMoveDialog = false"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
