<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { api } from "../../api/client";
import type { MemorySpace } from "../../api/types";
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

// --- Types ---
interface DocumentGroup {
  sourceFile: string;
  chunkCount: number;
  createdAt: number;
}

interface MemoryEntry {
  id: string;
  text: string;
  source: string;
  tags?: string;
  sourceFile?: string;
  chunkIndex?: number;
  createdAt: number;
}

// --- Constants ---
const SEMANTIC_SEARCH_DEBOUNCE_MS = 1500;

// --- State ---
const groups = ref<DocumentGroup[]>([]);
const groupsLoading = ref(false);
const groupChunks = ref<Map<string, MemoryEntry[]>>(new Map());
const groupChunksLoading = ref<Set<string>>(new Set());
const expandedGroup = ref<string | null>(null);
const selectedGroups = ref<Set<string>>(new Set());
const deleting = ref(false);
const moving = ref(false);
const exporting = ref(false);
const showMoveDialog = ref(false);

// Document viewer modal
const showDocumentModal = ref(false);
const modalSourceFile = ref("");

// Upload
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadProgress = ref({ current: 0, total: 0 });
const uploadResults = ref<
  { fileName: string; chunks: number; error?: string }[]
>([]);

// Reingest
const reingestingGroup = ref<string | null>(null);
const reingestFileInput = ref<HTMLInputElement | null>(null);
let pendingReingestSourceFile = "";

// Search + pagination
const GROUPS_PAGE_SIZE = 30;
const searchQuery = ref("");
const page = ref(0);
const semanticSearchEnabled = ref(false);
const semanticSearchLoading = ref(false);
const semanticMatchedSourceFiles = ref<Set<string> | null>(null);
let semanticSearchTimer: ReturnType<typeof setTimeout> | null = null;
let semanticSearchRequestId = 0;

const currentSpace = computed(() =>
  props.spaces.find((s) => s.id === props.spaceId),
);

const filteredGroups = computed(() => {
  const q = searchQuery.value.trim();
  if (!q) return groups.value;

  if (semanticSearchEnabled.value) {
    if (!semanticMatchedSourceFiles.value) return groups.value;
    return groups.value.filter((g) =>
      semanticMatchedSourceFiles.value?.has(g.sourceFile),
    );
  }

  const qLower = q.toLowerCase();
  return groups.value.filter((g) =>
    (g.sourceFile || "").toLowerCase().includes(qLower),
  );
});
const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredGroups.value.length / GROUPS_PAGE_SIZE)),
);
const pagedGroups = computed(() => {
  const start = page.value * GROUPS_PAGE_SIZE;
  return filteredGroups.value.slice(start, start + GROUPS_PAGE_SIZE);
});

const allFilteredSelected = computed(
  () =>
    filteredGroups.value.length > 0 &&
    filteredGroups.value.every((g) => selectedGroups.value.has(g.sourceFile)),
);

// --- Data loading ---
async function loadGroups() {
  groupsLoading.value = true;
  try {
    groups.value = await api.memorySpaces.listGroups(props.spaceId);
  } catch {
    groups.value = [];
  }
  groupsLoading.value = false;
}

function clearSemanticState(): void {
  if (semanticSearchTimer) {
    clearTimeout(semanticSearchTimer);
    semanticSearchTimer = null;
  }
  semanticSearchRequestId++;
  semanticSearchLoading.value = false;
  semanticMatchedSourceFiles.value = null;
}

async function runSemanticSearchNow(): Promise<void> {
  const query = searchQuery.value.trim();
  if (!semanticSearchEnabled.value || !query) {
    semanticMatchedSourceFiles.value = null;
    semanticSearchLoading.value = false;
    return;
  }

  const requestId = ++semanticSearchRequestId;
  semanticSearchLoading.value = true;
  try {
    const results = await api.memory.search(query, 200);
    if (requestId !== semanticSearchRequestId) return;

    const matched = new Set<string>();
    for (const result of results) {
      const row = (result ?? {}) as Record<string, unknown>;
      const spaceId = typeof row.spaceId === "string" ? row.spaceId : "";
      if (spaceId && spaceId !== props.spaceId) continue;

      const sourceFile =
        typeof row.sourceFile === "string" ? row.sourceFile : "";
      if (sourceFile) matched.add(sourceFile);
    }
    semanticMatchedSourceFiles.value = matched;
  } catch {
    if (requestId !== semanticSearchRequestId) return;
    semanticMatchedSourceFiles.value = new Set<string>();
  } finally {
    if (requestId === semanticSearchRequestId) {
      semanticSearchLoading.value = false;
    }
  }
}

function scheduleSemanticSearch(): void {
  if (semanticSearchTimer) clearTimeout(semanticSearchTimer);
  semanticSearchTimer = setTimeout(() => {
    void runSemanticSearchNow();
  }, SEMANTIC_SEARCH_DEBOUNCE_MS);
}

function onSearchInput(): void {
  page.value = 0;
  if (semanticSearchEnabled.value) {
    scheduleSemanticSearch();
  }
}

function toggleSemanticSearch(): void {
  semanticSearchEnabled.value = !semanticSearchEnabled.value;
  page.value = 0;
  if (semanticSearchEnabled.value) {
    scheduleSemanticSearch();
  } else {
    clearSemanticState();
  }
}

async function loadGroupChunks(sourceFile: string) {
  if (
    groupChunks.value.has(sourceFile) ||
    groupChunksLoading.value.has(sourceFile)
  )
    return;
  const loading = new Set(groupChunksLoading.value);
  loading.add(sourceFile);
  groupChunksLoading.value = loading;
  try {
    const entries = await api.memorySpaces.listEntries(
      props.spaceId,
      sourceFile,
    );
    const newMap = new Map(groupChunks.value);
    newMap.set(sourceFile, entries as MemoryEntry[]);
    groupChunks.value = newMap;
  } catch {
    /* error */
  }
  const l2 = new Set(groupChunksLoading.value);
  l2.delete(sourceFile);
  groupChunksLoading.value = l2;
}

// --- Selection ---
function toggleExpandGroup(sourceFile: string) {
  modalSourceFile.value = sourceFile;
  showDocumentModal.value = true;
  loadGroupChunks(sourceFile);
}

function toggleSelectGroup(sourceFile: string) {
  const s = new Set(selectedGroups.value);
  if (s.has(sourceFile)) s.delete(sourceFile);
  else s.add(sourceFile);
  selectedGroups.value = s;
}

function selectAllOnPage() {
  selectedGroups.value = new Set(pagedGroups.value.map((g) => g.sourceFile));
}

function selectAll() {
  selectedGroups.value = new Set(filteredGroups.value.map((g) => g.sourceFile));
}

// --- Bulk operations ---
async function deleteSelectedGroups() {
  if (selectedGroups.value.size === 0) return;
  deleting.value = true;
  try {
    await api.memorySpaces.deleteGroups(
      props.spaceId,
      Array.from(selectedGroups.value),
    );
    const deleted = selectedGroups.value;
    selectedGroups.value = new Set();
    const newMap = new Map(groupChunks.value);
    for (const sf of deleted) newMap.delete(sf);
    groupChunks.value = newMap;
    groups.value = groups.value.filter((g) => !deleted.has(g.sourceFile));
    const space = currentSpace.value;
    if (space) space.documentCount = groups.value.length;
  } catch {
    /* error */
  }
  deleting.value = false;
}

async function moveSelectedGroups(targetSpaceId: string) {
  await moveGroupsToSpace(targetSpaceId, Array.from(selectedGroups.value));
}

async function moveGroupsToSpace(targetSpaceId: string, sourceFiles?: string[]) {
  const files =
    selectedGroups.value.size > 0
      ? Array.from(selectedGroups.value)
      : sourceFiles ?? [];

  if (files.length === 0 || targetSpaceId === props.spaceId) return;

  moving.value = true;
  try {
    await api.memorySpaces.moveGroups(props.spaceId, files, targetSpaceId);
    const moved = new Set(files);
    selectedGroups.value = new Set();
    const newMap = new Map(groupChunks.value);
    for (const sf of moved) newMap.delete(sf);
    groupChunks.value = newMap;
    groups.value = groups.value.filter((g) => !moved.has(g.sourceFile));
    const space = currentSpace.value;
    if (space) space.documentCount = groups.value.length;
    showMoveDialog.value = false;
    emit("spacesChanged");
  } catch {
    /* error */
  }
  moving.value = false;
}

// --- Text helpers ---
function findOverlap(a: string, b: string): number {
  const maxLen = Math.min(a.length, b.length, 300);
  for (let len = maxLen; len > 0; len--) {
    if (a.endsWith(b.slice(0, len))) return len;
  }
  return 0;
}

function getMergedText(sf: string): string {
  const chunks = (groupChunks.value.get(sf) || [])
    .slice()
    .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  if (chunks.length === 0) return "";
  let result = chunks[0].text;
  for (let i = 1; i < chunks.length; i++) {
    const overlap = findOverlap(result, chunks[i].text);
    result += chunks[i].text.slice(overlap);
  }
  return result;
}

// --- Export ---
async function exportSelectedDocuments() {
  exporting.value = true;
  try {
    for (const sf of selectedGroups.value) {
      await exportDocument(sf);
    }
  } finally {
    exporting.value = false;
  }
}

async function exportDocument(sourceFile: string) {
  if (!groupChunks.value.has(sourceFile)) {
    await loadGroupChunks(sourceFile);
  }
  let text = getMergedText(sourceFile);
  if (!text) return;
  text = text
    .replace(/^\[File:[^\]]*\]\n(?:---\n[\s\S]*?\n---\n)?/, "")
    .trimStart();
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sourceFile || "document.txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Upload ---
const PARSEABLE_DOC_EXTENSIONS = new Set([
  ".docx",
  ".pptx",
  ".xlsx",
  ".odt",
  ".odp",
  ".ods",
  ".pdf",
  ".rtf",
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
      results.push({
        fileName: file.name,
        chunks: 0,
        error: "File too large (max 10MB)",
      });
      continue;
    }
    try {
      const content = await readFileContent(file);
      const res = await api.memorySpaces.ingestFile(
        props.spaceId,
        file.name,
        content,
      );
      results.push({ fileName: res.fileName, chunks: res.chunksStored });
    } catch (err) {
      results.push({
        fileName: file.name,
        chunks: 0,
        error: (err as Error).message,
      });
    }
    uploadResults.value = [...results];
  }
  uploadResults.value = results;
  uploading.value = false;
  const newMap = new Map(groupChunks.value);
  for (const r of results) {
    if (!r.error) newMap.delete(r.fileName);
  }
  groupChunks.value = newMap;
  loadGroups();
  emit("spacesChanged");
}

// --- Reingest ---
function startReingest(sourceFile: string) {
  pendingReingestSourceFile = sourceFile;
  reingestFileInput.value?.click();
}

function startDocumentDrag(event: DragEvent, sourceFile: string) {
  const sourceFiles =
    selectedGroups.value.size > 0 ? Array.from(selectedGroups.value) : [sourceFile];

  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(
    DOCUMENT_DRAG_MIME,
    JSON.stringify({ sourceFiles }),
  );
}

async function handleReingestFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !pendingReingestSourceFile) return;
  const sourceFile = pendingReingestSourceFile;
  reingestingGroup.value = sourceFile;
  try {
    const content = await readFileContent(file);
    const res = await api.memorySpaces.reingestFile(
      props.spaceId,
      sourceFile,
      content,
    );
    const idx = groups.value.findIndex((g) => g.sourceFile === sourceFile);
    if (idx !== -1)
      groups.value[idx] = {
        ...groups.value[idx],
        chunkCount: res.chunksStored,
        createdAt: Date.now(),
      };
    const newMap = new Map(groupChunks.value);
    newMap.delete(sourceFile);
    groupChunks.value = newMap;
    if (expandedGroup.value === sourceFile) loadGroupChunks(sourceFile);
  } catch {
    /* error */
  }
  reingestingGroup.value = null;
}

// --- Lifecycle ---
watch(
  () => props.spaceId,
  () => {
    groups.value = [];
    groupChunks.value = new Map();
    expandedGroup.value = null;
    selectedGroups.value = new Set();
    searchQuery.value = "";
    semanticSearchEnabled.value = false;
    clearSemanticState();
    page.value = 0;
    loadGroups();
  },
  { immediate: true },
);

defineExpose({ ingestFiles, moveGroupsToSpace })

function onChunkUpdated(chunkId: string, newText: string) {
  const chunks = groupChunks.value.get(modalSourceFile.value)
  if (!chunks) return
  const newMap = new Map(groupChunks.value)
  newMap.set(
    modalSourceFile.value,
    chunks.map((c) => (c.id === chunkId ? { ...c, text: newText } : c)),
  )
  groupChunks.value = newMap
};
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
        :class="
          r.error
            ? 'bg-red-500/10 text-red-300'
            : 'bg-green-500/10 text-green-300'
        "
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
        {{ filteredGroups.length }} document{{
          filteredGroups.length !== 1 ? "s" : ""
        }}
      </div>
      <div class="flex items-center gap-2">
        <template v-if="selectedGroups.size > 0">
          <button
            class="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            @click="selectedGroups = new Set()"
          >
            Clear
          </button>
          <button
            v-if="!allFilteredSelected"
            class="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            @click="selectAll"
          >
            Select all {{ filteredGroups.length }}
          </button>
          <button
            :disabled="exporting"
            class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/10 text-green-400 hover:bg-green-500/20 rounded transition-colors"
            @click="exportSelectedDocuments"
          >
            <Icon
              :icon="exporting ? 'lucide:loader-2' : 'lucide:download'"
              class="w-3.5 h-3.5"
              :class="{ 'animate-spin': exporting }"
            />
            Export {{ selectedGroups.size }}
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
            Move {{ selectedGroups.size }}
          </button>
          <button
            :disabled="deleting"
            class="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded transition-colors"
            @click="deleteSelectedGroups"
          >
            <Icon
              :icon="deleting ? 'lucide:loader-2' : 'lucide:trash-2'"
              class="w-3.5 h-3.5"
              :class="{ 'animate-spin': deleting }"
            />
            Delete {{ selectedGroups.size }}
          </button>
        </template>
        <template v-else-if="groups.length > 0">
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
            Select all {{ filteredGroups.length }}
          </button>
        </template>
        <button
          :disabled="groupsLoading"
          class="px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
          @click="loadGroups"
        >
          <Icon
            :icon="groupsLoading ? 'lucide:loader-2' : 'lucide:refresh-cw'"
            class="w-3.5 h-3.5"
            :class="{ 'animate-spin': groupsLoading }"
          />
        </button>
      </div>
    </div>

    <!-- Search -->
    <div
      v-if="groups.length > 0"
      class="mb-3 flex items-center gap-2"
    >
      <div class="relative flex-1">
        <Icon
          icon="lucide:search"
          class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500"
        />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search documents…"
          class="w-full pl-9 pr-3 py-2 text-sm bg-zinc-800/60 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
          @input="onSearchInput"
        >
      </div>

      <button
        type="button"
        class="px-3 py-2 rounded-lg border text-xs font-medium transition-colors flex items-center gap-1.5"
        :class="
          semanticSearchEnabled
            ? 'border-blue-500/50 bg-blue-500/10 text-blue-300'
            : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
        "
        :title="
          semanticSearchEnabled
            ? 'Semantic filtering enabled'
            : 'Enable semantic filtering'
        "
        @click="toggleSemanticSearch"
      >
        <Icon
          :icon="semanticSearchLoading ? 'lucide:loader-2' : 'lucide:sparkles'"
          class="w-3.5 h-3.5"
          :class="semanticSearchLoading ? 'animate-spin' : ''"
        />
        Semantic
      </button>
    </div>

    <!-- Empty states -->
    <div
      v-if="groups.length === 0 && !groupsLoading"
      class="text-center py-8 text-zinc-500 text-sm"
    >
      No documents in this space yet. Upload files to get started.
    </div>

    <div
      v-else-if="filteredGroups.length === 0 && searchQuery.trim()"
      class="text-center py-8 text-zinc-500 text-sm"
    >
      <span v-if="semanticSearchEnabled">
        No documents semantically matching "{{ searchQuery.trim() }}"
      </span>
      <span v-else> No documents matching "{{ searchQuery.trim() }}" </span>
    </div>

    <!-- Document rows -->
    <div
      v-else
      class="space-y-2"
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
        v-for="group in pagedGroups"
        :key="group.sourceFile"
        class="rounded-lg border border-zinc-800 overflow-hidden"
      >
        <!-- Group header -->
        <div
          draggable="true"
          class="group/row flex items-center gap-3 px-3 py-2.5 bg-zinc-800/30 hover:bg-zinc-800/60 transition-colors cursor-pointer"
          @click="toggleExpandGroup(group.sourceFile)"
          @dragstart.stop="startDocumentDrag($event, group.sourceFile)"
        >
          <input
            type="checkbox"
            class="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500/30"
            :checked="selectedGroups.has(group.sourceFile)"
            @click.stop
            @change.stop="toggleSelectGroup(group.sourceFile)"
          >
          <Icon
            icon="lucide:file-text"
            class="w-4 h-4 text-zinc-400 shrink-0"
          />
          <span class="flex-1 text-sm text-zinc-200 truncate">
            {{ group.sourceFile || "Untitled" }}
          </span>
          <span
            v-if="group.createdAt"
            class="text-[11px] text-zinc-600 shrink-0"
          >
            {{
              new Date(group.createdAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            }}
          </span>
          <span class="text-xs text-zinc-500 shrink-0">
            {{ group.chunkCount }} chunk{{ group.chunkCount !== 1 ? "s" : "" }}
          </span>
          <!-- Update button on hover -->
          <button
            class="p-1 rounded text-zinc-600 hover:text-blue-400 transition-colors shrink-0 opacity-0 group-hover/row:opacity-100"
            :class="{ 'opacity-100!': reingestingGroup === group.sourceFile }"
            title="Update document (re-ingest)"
            @click.stop="startReingest(group.sourceFile)"
          >
            <Icon
              :icon="
                reingestingGroup === group.sourceFile
                  ? 'lucide:loader-2'
                  : 'lucide:refresh-cw'
              "
              class="w-3.5 h-3.5"
              :class="{ 'animate-spin': reingestingGroup === group.sourceFile }"
            />
          </button>
          <Icon
            v-if="!groupChunksLoading.has(group.sourceFile)"
            icon="lucide:eye"
            class="w-4 h-4 text-zinc-500 shrink-0"
            title="View document"
          />
          <Icon
            v-else
            icon="lucide:loader-2"
            class="w-4 h-4 text-zinc-500 shrink-0 animate-spin"
          />
        </div>
      </div>
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

    <!-- Hidden file inputs -->
    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.html,.htm,.toml,.ini,.cfg,.conf,.rst,.tex,.py,.js,.ts,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.r,.swift,.kt,.docx,.pptx,.xlsx,.odt,.odp,.ods,.pdf,.rtf"
      class="hidden"
      @change="handleFileUpload"
    >
    <input
      ref="reingestFileInput"
      type="file"
      accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.html,.htm,.toml,.ini,.cfg,.conf,.rst,.tex,.py,.js,.ts,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.r,.swift,.kt,.docx,.pptx,.xlsx,.odt,.odp,.ods,.pdf,.rtf"
      class="hidden"
      @change="handleReingestFile"
    >

    <!-- Move Dialog -->
    <Teleport to="body">
      <div
        v-if="showMoveDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="showMoveDialog = false"
      >
        <div
          class="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-xl"
        >
          <h3 class="text-base font-medium text-zinc-200 mb-2">
            Move {{ selectedGroups.size }} document{{
              selectedGroups.size !== 1 ? "s" : ""
            }}
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
              @click="moveSelectedGroups(space.id)"
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
                  {{ space.documentCount }} document{{
                    space.documentCount !== 1 ? "s" : ""
                  }}
                </div>
              </div>
              <Icon
                v-if="moving"
                icon="lucide:loader-2"
                class="w-4 h-4 text-zinc-500 animate-spin shrink-0"
              />
              <Icon
                v-else
                icon="lucide:chevron-right"
                class="w-4 h-4 text-zinc-600 shrink-0"
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

    <!-- Document Viewer Modal -->
    <MemoryDocumentModal
      :show="showDocumentModal"
      :space-id="spaceId"
      :source-file="modalSourceFile"
      :chunk-count="
        groups.find((g) => g.sourceFile === modalSourceFile)?.chunkCount || 0
      "
      :chunks="groupChunks.get(modalSourceFile) || []"
      :loading="groupChunksLoading.has(modalSourceFile)"
      @close="showDocumentModal = false"
      @chunk-updated="onChunkUpdated"
    />
  </div>
</template>
