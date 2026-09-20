<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, toRef, watch } from "vue";
import { api } from "../../api/client";
import { RUNTIME_LIMITS } from "@shared/runtime-limits";
import type { MemoryFolder, MemoryFileStatus, MemoryFileSearchResult, MemoryIndexJob } from "../../api/types";
import { Icon } from "@iconify/vue";
import MemoryDocumentEditorModal from "./MemoryDocumentEditorModal.vue";
import DataTable, { type Column } from "../shared/DataTable.vue";
import { useMemoryDocumentJobs } from "../../composables/useMemoryDocumentJobs";
import MemoryDocumentMoveDialog from "./MemoryDocumentMoveDialog.vue";
import ModalDialog from "../shared/ModalDialog.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";

interface DocumentDragPayload {
  sourceFolderId: string;
  sourceFiles: string[];
}

type DocumentRow = MemoryFileStatus & { id: string; kind: "file"; name: string };
type FolderRow = {
  id: string;
  kind: "folder";
  name: string;
  folder: MemoryFolder;
  modifiedAt: number;
  chunkCount?: number;
  deepResearched: false;
  status: "folder";
};
type ExplorerRow = DocumentRow | FolderRow;
type GlobalDocumentRow = MemoryFileSearchResult & { id: string };

const props = defineProps<{
  folderId: string;
  spaces: MemoryFolder[];
  focusFile?: string;
}>();

const emit = defineEmits<{
  editSpace: [];
  deleteSpace: [];
  createFolder: [parent: MemoryFolder];
  editFolder: [folder: MemoryFolder];
  deleteFolder: [folder: MemoryFolder];
  toggleAutoMemoryExclusion: [folder: MemoryFolder];
  spacesChanged: [];
  navigateFolder: [folderId: string];
  documentDragState: [active: boolean, payload?: DocumentDragPayload];
  openGlobalDocument: [folderId: string, fileName: string];
}>();

// --- Constants ---
const FILES_PAGE_SIZE = 30;
const LARGE_CHUNK_WARNING_THRESHOLD = 100;
const EXPLORER_VIEW_KEY = "cy-memory-explorer-view";

/** Deep Research eligibility is decided by the limit the server attaches to
 * each file row, so the button can never be offered for a document the server
 * would reject. See api/limits.ts for the rationale. The served limits value is
 * only a fallback for a file row from an older server. */
function analysisChunkLimit(file: MemoryFileStatus): number {
  return file.analysisChunkLimit ?? RUNTIME_LIMITS.analysisChunkLimit;
}

function supportsAnalysis(file: MemoryFileStatus): boolean {
  return file.status === "indexed" && (file.chunkCount || 0) <= analysisChunkLimit(file);
}

// --- State ---
const files = ref<MemoryFileStatus[]>([]);
const filesLoading = ref(false);
const selectedFiles = ref<Set<string>>(new Set());
const selectedFolders = ref<Set<string>>(new Set());
const gridSelectionAnchor = ref<string | null>(null);
const deleting = ref(false);
const forgettingMemories = ref(false);
const moving = ref(false);
const showMoveDialog = ref(false);
const savedExplorerView = localStorage.getItem(EXPLORER_VIEW_KEY);
const explorerView = ref<"list" | "grid">(
  savedExplorerView === "grid" || savedExplorerView === "list"
    ? savedExplorerView
    : window.matchMedia("(max-width: 639px)").matches ? "grid" : "list",
);
const highlightedFolderId = ref<string | null>(null);
const dropTargetFolderId = ref<string | null>(null);
const activeDocumentDrag = ref<DocumentDragPayload | null>(null);
const contextMenu = ref<{
  kind: "folder" | "document";
  folder?: MemoryFolder;
  file?: MemoryFileStatus;
  x: number;
  y: number;
} | null>(null);
const unsubscribeGraphReset = api.memory.onGraphReset(() => {
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
const showLargeChunkWarning = ref(false);
const largeChunkWarningFiles = ref<MemoryFileStatus[]>([]);
let pendingIndexAction: (() => Promise<void>) | null = null;

// Search + pagination
const searchQuery = ref("");
const semanticSearch = ref(false);
const page = ref(0);
const visibleDocumentRows = ref<ExplorerRow[]>([]);
const globalSearchResults = ref<MemoryFileSearchResult[]>([]);
const globalSearchLoading = ref(false);
let globalSearchTimer: number | null = null;
let globalSearchSequence = 0;

const currentSpace = computed(() => props.spaces.find((s) => s.id === props.folderId));
const childFolders = computed(() => {
  const current = currentSpace.value;
  if (!current) return [];
  return props.spaces
    .filter((folder) => {
      if (folder.isUncategorized) return false;
      return current.isUncategorized
        ? !folder.parentFolderPath
        : folder.parentFolderPath === current.folderPath;
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
});
const folderHistory = ref<string[]>([props.folderId]);
const folderHistoryIndex = ref(0);
const canNavigateBack = computed(() => folderHistoryIndex.value > 0);
const canNavigateForward = computed(() => folderHistoryIndex.value < folderHistory.value.length - 1);
const pathCopied = ref(false);
let pathCopiedTimer: number | null = null;

const pathSegments = computed(() => {
  const path = currentSpace.value?.directoryPath || "";
  return path.split(/[\\/]+/).filter(Boolean).map((label, index, segments) => ({
    label,
    folderId: props.spaces.find((space) => {
      const candidate = (space.directoryPath || "").split(/[\\/]+/).filter(Boolean);
      return candidate.length === index + 1 && candidate.every((part, partIndex) => part === segments[partIndex]);
    })?.id,
  }));
});

async function copyCurrentFolderPath(): Promise<void> {
  const path = currentSpace.value?.directoryPath;
  if (!path) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(path);
    } else {
      const input = document.createElement("textarea");
      input.value = path;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    pathCopied.value = true;
    if (pathCopiedTimer !== null) window.clearTimeout(pathCopiedTimer);
    pathCopiedTimer = window.setTimeout(() => {
      pathCopied.value = false;
      pathCopiedTimer = null;
    }, 1600);
  } catch {
    pathCopied.value = false;
  }
}

function navigateHistory(offset: -1 | 1): void {
  const nextIndex = folderHistoryIndex.value + offset;
  const folderId = folderHistory.value[nextIndex];
  if (!folderId || nextIndex < 0 || nextIndex >= folderHistory.value.length) return;
  folderHistoryIndex.value = nextIndex;
  emit("navigateFolder", folderId);
}

function navigateBreadcrumb(folderId?: string): void {
  if (folderId && folderId !== props.folderId) emit("navigateFolder", folderId);
}

function setExplorerView(view: "list" | "grid"): void {
  explorerView.value = view;
  localStorage.setItem(EXPLORER_VIEW_KEY, view);
}

function openFolder(folder: MemoryFolder): void {
  contextMenu.value = null;
  emit("navigateFolder", folder.id);
}

function openDocumentRow(file: DocumentRow): void {
  highlightedFolderId.value = null;
  openEditorModal(file.fileName);
}

function openExplorerRow(item: ExplorerRow): void {
  if (item.kind === "folder") openFolder(item.folder);
  else openDocumentRow(item);
}

function openExplorerContextMenu(item: ExplorerRow, event: MouseEvent): void {
  if (item.kind === "folder") openContextMenu("folder", event, item.folder);
  else openContextMenu("document", event, item);
}

function startExplorerDrag(item: ExplorerRow, event: DragEvent): void {
  if (item.kind === "file") startDocumentDrag(event, item.fileName);
}

function dragOverExplorerRow(item: ExplorerRow, event: DragEvent): void {
  if (item.kind === "folder") onFolderDocumentDragOver(item.folder, event);
}

function dragLeaveExplorerRow(item: ExplorerRow, event: DragEvent): void {
  if (item.kind === "folder") onFolderDocumentDragLeave(item.folder, event);
}

function dropOnExplorerRow(item: ExplorerRow, event: DragEvent): void {
  if (item.kind === "folder") void onFolderDocumentDrop(item.folder, event);
}

function isExplorerRowSelectable(item: ExplorerRow): boolean {
  return item.kind === "folder" || item.supported;
}

function toggleGridSelection(item: ExplorerRow, event: MouseEvent): void {
  if (!isExplorerRowSelectable(item)) return;
  const next = new Set(selectedExplorerIds.value);
  const anchorIndex = gridSelectionAnchor.value
    ? documentRows.value.findIndex((candidate) => candidate.id === gridSelectionAnchor.value)
    : -1;
  const clickedIndex = documentRows.value.findIndex((candidate) => candidate.id === item.id);
  if (event.shiftKey && anchorIndex >= 0 && clickedIndex >= 0) {
    const start = Math.min(anchorIndex, clickedIndex);
    const end = Math.max(anchorIndex, clickedIndex);
    for (const candidate of documentRows.value.slice(start, end + 1)) {
      if (isExplorerRowSelectable(candidate)) next.add(candidate.id);
    }
  } else {
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
  }
  if (!event.shiftKey || anchorIndex < 0) gridSelectionAnchor.value = item.id;
  selectedExplorerIds.value = [...next];
}

function rowForFolder(folder: MemoryFolder): FolderRow {
  return documentRows.value.find((item): item is FolderRow => item.kind === "folder" && item.folder.id === folder.id)!;
}

function rowForFile(file: MemoryFileStatus): DocumentRow {
  return documentRows.value.find((item): item is DocumentRow => item.kind === "file" && item.fileName === file.fileName)!;
}

function onFolderDocumentDragOver(folder: MemoryFolder, event: DragEvent): void {
  if (!activeDocumentDrag.value || folder.id === props.folderId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTargetFolderId.value = folder.id;
}

function onFolderDocumentDragLeave(folder: MemoryFolder, event: DragEvent): void {
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.contains(event.relatedTarget as Node)) return;
  if (dropTargetFolderId.value === folder.id) dropTargetFolderId.value = null;
}

async function onFolderDocumentDrop(folder: MemoryFolder, event: DragEvent): Promise<void> {
  if (!activeDocumentDrag.value || folder.id === props.folderId) return;
  event.preventDefault();
  const sourceFiles = activeDocumentDrag.value.sourceFiles;
  dropTargetFolderId.value = null;
  activeDocumentDrag.value = null;
  await moveDocumentsToFolder(folder.id, sourceFiles);
}

function openContextMenu(
  kind: "folder" | "document",
  event: MouseEvent,
  item: MemoryFolder | MemoryFileStatus,
): void {
  event.preventDefault();
  if (kind === "folder") {
    const folder = item as MemoryFolder;
    highlightedFolderId.value = folder.id;
    if (!selectedFolders.value.has(folder.id)) {
      clearSelection();
      selectedFolders.value = new Set([folder.id]);
    }
  } else {
    const file = item as MemoryFileStatus;
    highlightedFolderId.value = null;
    if (!selectedFiles.value.has(file.fileName)) {
      clearSelection();
      selectedFiles.value = file.supported ? new Set([file.fileName]) : new Set();
    }
  }
  const menuWidth = 240;
  const menuHeight = kind === "folder" ? 248 : 286;
  contextMenu.value = {
    kind,
    folder: kind === "folder" ? item as MemoryFolder : undefined,
    file: kind === "document" ? item as MemoryFileStatus : undefined,
    x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
    y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
  };
}

function closeContextMenu(): void {
  contextMenu.value = null;
}

watch(() => props.folderId, (folderId) => {
  if (folderHistory.value[folderHistoryIndex.value] === folderId) return;
  folderHistory.value = [...folderHistory.value.slice(0, folderHistoryIndex.value + 1), folderId];
  folderHistoryIndex.value = folderHistory.value.length - 1;
});

const filteredFiles = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return files.value;
  return files.value.filter((f) =>
    f.fileName.toLowerCase().includes(q) || (f.tags || []).some((tag) => tag.includes(q)),
  );
});

const documentRows = computed<ExplorerRow[]>(() => [
  ...childFolders.value.map((folder): FolderRow => ({
    id: `folder:${folder.id}`,
    kind: "folder",
    name: folder.name,
    folder,
    modifiedAt: folder.createdAt,
    chunkCount: folder.fileCount + (folder.descendantFileCount || 0),
    deepResearched: false,
    status: "folder",
  })),
  ...filteredFiles.value.map((file): DocumentRow => ({
    ...file,
    id: `file:${file.fileName}`,
    kind: "file",
    name: file.fileName,
  })),
]);
const globalDocumentRows = computed<GlobalDocumentRow[]>(() => globalSearchResults.value.map((file) => ({
  ...file,
  id: `${file.folderId}\0${file.fileName}`,
})));

const selectedExplorerIds = computed({
  get: () => [
    ...Array.from(selectedFolders.value, (id) => `folder:${id}`),
    ...Array.from(selectedFiles.value, (name) => `file:${name}`),
  ],
  set: (value: string[]) => {
    selectedFolders.value = new Set(value.filter((id) => id.startsWith("folder:")).map((id) => id.slice(7)));
    selectedFiles.value = new Set(value.filter((id) => id.startsWith("file:")).map((id) => id.slice(5)));
  },
});

const columns: Column<ExplorerRow>[] = [
  { key: "name", label: "Name", minWidth: "220px", grow: 3, sortable: true, sortValue: (item) => item.name },
  { key: "modifiedAt", label: "Modified", minWidth: "104px", sortable: true, sortValue: (file) => file.modifiedAt },
  { key: "chunkCount", label: "Items / Chunks", minWidth: "90px", grow: 0, sortable: true, sortValue: (item) => item.kind === "folder" ? item.chunkCount : item.status === "indexed" ? (item.chunkCount || 0) : (item.estimatedChunkCount || 0) },
  { key: "deepResearched", label: "Deep Research", minWidth: "190px", sortable: true, sortValue: (item) => item.kind === "file" && item.deepResearched },
  { key: "status", label: "Type / Searchable", minWidth: "220px", grow: 1.15, sortable: true, sortValue: (item) => item.status },
];

const globalColumns: Column<GlobalDocumentRow>[] = [
  { key: "fileName", label: "File", minWidth: "220px", grow: 3, sortable: true, sortValue: (file) => file.fileName },
  { key: "folderName", label: "Folder", minWidth: "150px", grow: 1.5, sortable: true, sortValue: (file) => file.folderPath || file.folderName },
  { key: "modifiedAt", label: "Modified", minWidth: "104px", sortable: true, sortValue: (file) => file.modifiedAt },
  { key: "status", label: "Searchable", minWidth: "150px", grow: 1, sortable: true, sortValue: (file) => file.status },
];
const semanticMatchColumn: Column<GlobalDocumentRow> = {
  key: "similarity",
  label: "Match",
  minWidth: "82px",
  grow: 0,
  sortable: true,
  sortValue: (file) => file.similarity ?? 0,
};
const searchColumns = computed(() => semanticSearch.value
  ? [...globalColumns.slice(0, 2), semanticMatchColumn, ...globalColumns.slice(2)]
  : globalColumns);

const allFilteredSelected = computed(
  () => {
    const selectable = documentRows.value.filter(isExplorerRowSelectable);
    return selectable.length > 0 && selectable.every((item) => item.kind === "folder"
      ? selectedFolders.value.has(item.folder.id)
      : selectedFiles.value.has(item.fileName));
  },
);
const selectedItemCount = computed(() => selectedFiles.value.size + selectedFolders.value.size);

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
  try {
    files.value = await api.memoryFolders.listFiles(props.folderId);
  } catch {
    files.value = [];
  }
  filesLoading.value = false;
}

const {
  runningJobs,
  isJobActive,
  failedJobs,
  dismissFailure,
  dismissAllFailures,
  upsertJob,
  loadJobs,
  reindexFile,
  extractKnowledgeFromFile,
  reindexAll: reindexAllNow,
  reset: resetJobs,
} = useMemoryDocumentJobs({
  folderId: toRef(props, "folderId"),
  files,
  reloadFiles: loadFiles,
  onCompleted: () => emit("spacesChanged"),
});

function estimatedChunks(file: MemoryFileStatus): number {
  return file.estimatedChunkCount ?? file.chunkCount ?? 0;
}

async function confirmLargeIndex(): Promise<void> {
  const action = pendingIndexAction;
  pendingIndexAction = null;
  showLargeChunkWarning.value = false;
  largeChunkWarningFiles.value = [];
  await action?.();
}

function cancelLargeIndex(): void {
  pendingIndexAction = null;
  showLargeChunkWarning.value = false;
  largeChunkWarningFiles.value = [];
}

async function indexWithWarning(candidates: MemoryFileStatus[], action: () => Promise<void>): Promise<void> {
  const largeFiles = candidates.filter((file) => estimatedChunks(file) > LARGE_CHUNK_WARNING_THRESHOLD);
  if (!largeFiles.length) {
    await action();
    return;
  }
  largeChunkWarningFiles.value = largeFiles;
  pendingIndexAction = action;
  showLargeChunkWarning.value = true;
}

async function reindexAll(): Promise<void> {
  const candidates = files.value.filter((file) =>
    file.supported && (file.status === "needs_reindex" || file.status === "not_indexed"),
  );
  await indexWithWarning(candidates, reindexAllNow);
}

function jobKindLabel(kind: MemoryIndexJob["kind"]): string {
  if (kind === "deep-research") return "Deep Research";
  if (kind === "tool-embeddings") return "Tool indexing";
  return "Search indexing";
}

async function deepResearchSelected(): Promise<void> {
  const groups = await resolveSelectedFileGroups();
  for (const [folderId, groupFiles] of groups) {
    for (const file of groupFiles.filter((candidate) => supportsAnalysis(candidate))) {
      if (folderId === props.folderId) {
        if (!isJobActive("deep-research", file.fileName)) await extractKnowledgeFromFile(file.fileName);
      } else {
        await api.memoryFolders.startDeepResearchFile(folderId, file.fileName);
      }
    }
  }
}

async function makeSearchableSelected(): Promise<void> {
  const groups = await resolveSelectedFileGroups();
  const candidates = [...groups.values()].flat().filter((file) =>
    file.supported && (file.status === "needs_reindex" || file.status === "not_indexed"),
  );
  await indexWithWarning(candidates, async () => {
    for (const [folderId, groupFiles] of groups) {
      for (const file of groupFiles.filter((candidate) =>
        candidate.supported && (candidate.status === "needs_reindex" || candidate.status === "not_indexed"),
      )) {
        if (folderId === props.folderId) await reindexFile(file.fileName);
        else await api.memoryFolders.startReindexFile(folderId, file.fileName);
      }
    }
  });
}

function selectAllOnPage() {
  selectedExplorerIds.value = visibleDocumentRows.value.filter(isExplorerRowSelectable).map((item) => item.id);
}

function selectAll() {
  selectedFolders.value = new Set(childFolders.value.map((folder) => folder.id));
  selectedFiles.value = new Set(filteredFiles.value.filter((f) => f.supported).map((f) => f.fileName));
}

function clearSelection(): void {
  selectedFiles.value = new Set();
  selectedFolders.value = new Set();
  gridSelectionAnchor.value = null;
}

function selectedFolderScope(): MemoryFolder[] {
  const selected = props.spaces.filter((folder) => selectedFolders.value.has(folder.id));
  return props.spaces.filter((candidate) => selected.some((folder) =>
    candidate.id === folder.id || Boolean(folder.folderPath && candidate.folderPath.startsWith(`${folder.folderPath}/`)),
  ));
}

async function resolveSelectedFileGroups(): Promise<Map<string, MemoryFileStatus[]>> {
  const groups = new Map<string, MemoryFileStatus[]>();
  const direct = files.value.filter((file) => selectedFiles.value.has(file.fileName));
  if (direct.length) groups.set(props.folderId, direct);
  await Promise.all(selectedFolderScope().map(async (folder) => {
    const folderFiles = await api.memoryFolders.listFiles(folder.id);
    if (folderFiles.length) groups.set(folder.id, folderFiles);
  }));
  return groups;
}

const moveTargetSpaces = computed(() => {
  const selected = props.spaces.filter((folder) => selectedFolders.value.has(folder.id));
  return props.spaces.filter((candidate) => candidate.id !== props.folderId && !selected.some((folder) =>
    candidate.id === folder.id || Boolean(folder.folderPath && candidate.folderPath.startsWith(`${folder.folderPath}/`)),
  ));
});

// --- Bulk removal ---
async function deleteSelectedFiles() {
  if (selectedItemCount.value === 0) return;
  deleting.value = true;
  try {
    if (selectedFiles.value.size) {
      await api.memoryFolders.deleteDocuments(props.folderId, Array.from(selectedFiles.value));
    }
    for (const folder of props.spaces.filter((item) => selectedFolders.value.has(item.id))) {
      await api.memoryFolders.remove(folder.id);
    }
    const deleted = selectedFiles.value;
    clearSelection();
    files.value = files.value.filter((f) => !deleted.has(f.fileName));
    emit("spacesChanged");
  } catch {
    /* error */
  }
  deleting.value = false;
}

async function forgetSelectedMemories() {
  const groups = await resolveSelectedFileGroups();
  if (groups.size === 0) return;
  forgettingMemories.value = true;
  try {
    for (const [folderId, groupFiles] of groups) {
      const sourceFiles = groupFiles
        .filter((file) => file.status !== "not_indexed" || file.deepResearched)
        .map((file) => file.fileName);
      if (sourceFiles.length) await api.memoryFolders.forgetMemories(folderId, sourceFiles);
    }
    clearSelection();
    await loadFiles();
    await loadJobs();
    emit("spacesChanged");
  } catch {
    /* error */
  }
  forgettingMemories.value = false;
}

// --- Move ---
async function moveSelectedFiles(targetFolderId: string) {
  if (selectedItemCount.value === 0 || targetFolderId === props.folderId) return;
  const target = props.spaces.find((folder) => folder.id === targetFolderId);
  if (!target) return;
  moving.value = true;
  try {
    if (selectedFiles.value.size) {
      await api.memoryFolders.moveDocuments(props.folderId, Array.from(selectedFiles.value), targetFolderId);
    }
    for (const folder of props.spaces.filter((item) => selectedFolders.value.has(item.id))) {
      const folderPath = target.folderPath ? `${target.folderPath}/${folder.name}` : folder.name;
      await api.memoryFolders.update(folder.id, { folderPath });
    }
    const moved = selectedFiles.value;
    clearSelection();
    files.value = files.value.filter((f) => !moved.has(f.fileName));
    showMoveDialog.value = false;
    emit("spacesChanged");
  } catch {
    /* error */
  }
  moving.value = false;
}

async function moveDocumentsToFolder(targetFolderId: string, sourceFiles: string[]) {
  if (sourceFiles.length === 0 || targetFolderId === props.folderId) return;
  try {
    await api.memoryFolders.moveDocuments(props.folderId, sourceFiles, targetFolderId);
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
      const res = await api.memoryFolders.ingestFile(props.folderId, file.name, content);
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
  emit("openGlobalDocument", file.folderId, file.fileName);
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
  const payload = { sourceFolderId: props.folderId, sourceFiles: fileNames } satisfies DocumentDragPayload;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DOCUMENT_DRAG_MIME, JSON.stringify(payload));
  event.dataTransfer.setData("text/plain", JSON.stringify(payload));
  activeDocumentDrag.value = payload;
  emit("documentDragState", true, payload);
}

function endDocumentDrag() {
  activeDocumentDrag.value = null;
  dropTargetFolderId.value = null;
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
  () => props.folderId,
  async (folderId) => {
    files.value = [];
    clearSelection();
    resetJobs();
    showEditorModal.value = false;
    editorFileName.value = "";
    searchQuery.value = "";
    highlightedFolderId.value = null;
    contextMenu.value = null;
    page.value = 0;
    await Promise.all([loadFiles(), loadJobs()]);
    if (props.folderId === folderId && props.focusFile) openEditorModal(props.focusFile);
  },
  { immediate: true },
);

watch(() => props.focusFile, (fileName) => {
  if (fileName) openEditorModal(fileName);
});

watch([searchQuery, () => props.folderId, semanticSearch], ([query]) => {
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
  selectedFolders.value = new Set();
  globalSearchLoading.value = true;
  globalSearchTimer = window.setTimeout(async () => {
    try {
      const results = await api.memoryFolders.searchFiles(trimmed, {
        folderId: props.folderId,
        semantic: semanticSearch.value,
      });
      if (sequence === globalSearchSequence) globalSearchResults.value = results;
    } catch {
      if (sequence === globalSearchSequence) globalSearchResults.value = [];
    } finally {
      if (sequence === globalSearchSequence) globalSearchLoading.value = false;
    }
  }, 200);
}, { immediate: true });

function handleExplorerPointerDown(event: MouseEvent): void {
  if (!(event.target as HTMLElement).closest("[data-memory-context-menu]")) closeContextMenu();
}

function handleExplorerKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeContextMenu();
}

onMounted(() => {
  document.addEventListener("mousedown", handleExplorerPointerDown);
  window.addEventListener("keydown", handleExplorerKeydown);
});

onUnmounted(() => {
  if (globalSearchTimer !== null) window.clearTimeout(globalSearchTimer);
  if (pathCopiedTimer !== null) window.clearTimeout(pathCopiedTimer);
  window.clearInterval(dreamIndicatorTimer);
  unsubscribeGraphReset();
  unsubscribeDreamUpdate();
  document.removeEventListener("mousedown", handleExplorerPointerDown);
  window.removeEventListener("keydown", handleExplorerKeydown);
});

defineExpose({ ingestFiles, moveDocumentsToFolder, openDocument });
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
          v-if="currentSpace"
          type="button"
          class="flex items-center gap-2 rounded-lg border border-theme-800 bg-theme-900/60 px-3 py-1.5 text-sm text-theme-300 transition-colors hover:bg-theme-800/60"
          @click="emit('createFolder', currentSpace)"
        >
          <Icon
            icon="lucide:folder-plus"
            class="h-4 w-4 text-amber-400"
          />
          New folder
        </button>
        <button
          v-if="needsAttentionCount > 0"
          title="Indexing files makes them available for semantic searching."
          class="px-3 py-1.5 bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 rounded-lg text-sm transition-colors flex items-center gap-2"
          @click="reindexAll"
        >
          <Icon
            icon="lucide:refresh-cw"
            class="w-4 h-4"
          />
          Index all {{ needsAttentionCount }} files
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

    <!-- Explorer toolbar -->
    <div class="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
      <div class="flex min-w-0 items-center gap-2">
        <div class="flex shrink-0 items-center rounded-lg border border-theme-800 bg-theme-900/60 p-0.5">
          <button
            type="button"
            :disabled="!canNavigateBack"
            class="flex h-7 w-7 items-center justify-center rounded-md text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-not-allowed disabled:opacity-30"
            title="Back to previous folder"
            aria-label="Back to previous folder"
            @click="navigateHistory(-1)"
          >
            <Icon
              icon="lucide:arrow-left"
              class="h-3.5 w-3.5"
            />
          </button>
          <button
            type="button"
            :disabled="!canNavigateForward"
            class="flex h-7 w-7 items-center justify-center rounded-md text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-not-allowed disabled:opacity-30"
            title="Forward to next folder"
            aria-label="Forward to next folder"
            @click="navigateHistory(1)"
          >
            <Icon
              icon="lucide:arrow-right"
              class="h-3.5 w-3.5"
            />
          </button>
        </div>

        <nav
          v-if="pathSegments.length"
          class="flex min-w-0 flex-1 items-center overflow-x-auto rounded-lg border border-theme-800 bg-theme-900/40 px-2 py-1.5 text-xs"
          aria-label="Memory folder path"
        >
          <button
            type="button"
            class="mr-1.5 shrink-0 rounded p-0.5 text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200"
            :title="pathCopied ? 'Path copied' : 'Copy folder path'"
            aria-label="Copy current folder path"
            @click="copyCurrentFolderPath"
          >
            <Icon
              :icon="pathCopied ? 'lucide:check' : 'lucide:clipboard'"
              class="h-3.5 w-3.5"
            />
          </button>
          <template
            v-for="(segment, index) in pathSegments"
            :key="`${segment.label}-${index}`"
          >
            <Icon
              v-if="index > 0"
              icon="lucide:chevron-right"
              class="h-3 w-3 shrink-0 text-theme-700"
            />
            <button
              type="button"
              :disabled="!segment.folderId || segment.folderId === folderId"
              class="shrink-0 rounded px-1.5 py-0.5 transition-colors enabled:hover:bg-theme-800 disabled:cursor-default"
              :class="segment.folderId ? 'text-accent-300 enabled:hover:text-accent-200' : 'text-theme-300'"
              @click="navigateBreadcrumb(segment.folderId)"
            >
              {{ segment.label }}
            </button>
          </template>
        </nav>
      </div>
    </div>

    <div
      id="memory-document-search"
      class="mb-3 rounded-lg border border-theme-800 bg-theme-950/30 p-2"
    >
      <div class="flex min-w-0 items-center gap-2">
        <div class="relative min-w-0 flex-1">
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-500"
          />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search this folder and subfolders…"
            class="w-full rounded-lg border border-theme-800 bg-theme-900/60 py-2 pl-9 pr-14 text-sm text-theme-200 placeholder-theme-500 transition-colors focus:border-theme-600 focus:outline-none"
            @input="page = 0"
          >
          <Icon
            v-if="globalSearchLoading"
            icon="lucide:loader-2"
            class="absolute right-9 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-theme-500"
          />
          <button
            v-if="searchQuery"
            type="button"
            class="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200"
            title="Clear search"
            aria-label="Clear document search"
            @click="searchQuery = ''"
          >
            <Icon
              icon="lucide:x"
              class="h-3.5 w-3.5"
            />
          </button>
        </div>
        <button
          type="button"
          :aria-pressed="semanticSearch"
          aria-label="Toggle semantic search"
          class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors"
          :class="semanticSearch
            ? 'border-accent-500/50 bg-accent-500/15 text-accent-300'
            : 'border-theme-800 bg-theme-900/60 text-theme-500 hover:bg-theme-800 hover:text-theme-200'"
          :title="semanticSearch ? 'Semantic search is on' : 'Search document vectors by meaning'"
          @click="semanticSearch = !semanticSearch"
        >
          <Icon
            icon="lucide:sparkles"
            class="h-3.5 w-3.5"
          />
          <span class="hidden sm:inline">Semantic</span>
        </button>
      </div>
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
          {{ globalSearchResults.length }} result{{ globalSearchResults.length !== 1 ? "s" : "" }}
          in {{ currentSpace?.name || "this folder" }} and subfolders
        </template>
        <template v-else>
          {{ childFolders.length }} folder{{ childFolders.length !== 1 ? "s" : "" }} ·
          {{ files.length }} file{{ files.length !== 1 ? "s" : "" }}
        </template>
        <template v-if="runningJobs.length > 0">
          · {{ runningJobs.length }} job{{ runningJobs.length !== 1 ? "s" : "" }} active
        </template>
      </div>
      <div class="flex items-center gap-2">
        <template v-if="!searchQuery.trim() && selectedItemCount === 0 && documentRows.length > 0">
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
        <div
          v-if="!searchQuery.trim()"
          class="flex items-center rounded-lg border border-theme-800 bg-theme-900/60 p-0.5"
          aria-label="Explorer view"
        >
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
            :class="explorerView === 'list' ? 'bg-theme-700 text-theme-100' : 'text-theme-500 hover:text-theme-200'"
            title="List view"
            aria-label="List view"
            :aria-pressed="explorerView === 'list'"
            @click="setExplorerView('list')"
          >
            <Icon
              icon="lucide:list"
              class="h-3.5 w-3.5"
            />
          </button>
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
            :class="explorerView === 'grid' ? 'bg-theme-700 text-theme-100' : 'text-theme-500 hover:text-theme-200'"
            title="Grid view"
            aria-label="Grid view"
            :aria-pressed="explorerView === 'grid'"
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

    <!-- Floating bulk actions: pinned inside the document area while scrolling. -->
    <div
      v-if="!searchQuery.trim() && selectedItemCount > 0"
      class="pointer-events-none sticky top-[calc(100vh_-_8rem)] z-30 h-0 sm:top-[calc(100vh_-_5.5rem)]"
    >
      <div class="pointer-events-auto mx-auto flex w-fit max-w-full items-center overflow-x-auto rounded-xl border border-theme-700/80 bg-theme-950/95 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <span class="shrink-0 border-r border-theme-800 px-3 text-xs font-medium text-theme-300">
          {{ selectedItemCount }} selected
        </span>
        <button
          v-if="!allFilteredSelected"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-theme-400 transition-colors hover:bg-theme-800 hover:text-theme-200"
          @click="selectAll"
        >
          Select all {{ documentRows.length }}
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
          v-if="selectedSearchIndexFiles.length > 0 || selectedFolders.size > 0"
          :disabled="selectedFolders.size === 0 && selectedSearchIndexIdleCount === 0"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-orange-400 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
          title="Build or refresh semantic search vectors for the selected documents"
          @click="makeSearchableSelected"
        >
          <Icon
            :icon="selectedFolders.size === 0 && selectedSearchIndexIdleCount === 0 ? 'lucide:loader-2' : 'lucide:search-check'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': selectedFolders.size === 0 && selectedSearchIndexIdleCount === 0 }"
          />
          Index files
        </button>
        <button
          v-if="selectedDeepResearchFiles.length > 0 || selectedFolders.size > 0"
          :disabled="selectedFolders.size === 0 && selectedDeepResearchIdleCount === 0"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
          title="Extract and classify facts from the selected searchable documents"
          @click="deepResearchSelected"
        >
          <Icon
            :icon="selectedFolders.size === 0 && selectedDeepResearchIdleCount === 0 ? 'lucide:loader-2' : 'lucide:network'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': selectedFolders.size === 0 && selectedDeepResearchIdleCount === 0 }"
          />
          Deep Research
        </button>
        <button
          v-if="selectedRememberedFiles.length > 0 || selectedFolders.size > 0"
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
          @click="clearSelection"
        >
          <Icon
            icon="lucide:x"
            class="h-4 w-4"
          />
        </button>
      </div>
    </div>

    <!-- Scoped or global search results -->
    <DataTable
      v-if="searchQuery.trim()"
      v-model:page="page"
      :items="globalDocumentRows"
      :columns="searchColumns"
      :selectable="false"
      :row-clickable="true"
      :row-class="(file) => !file.textDirect ? 'opacity-60' : 'cursor-pointer'"
      :pagination="true"
      :page-size="FILES_PAGE_SIZE"
      pagination-position="both"
      :empty-message="globalSearchLoading ? 'Searching…' : `No files matching '${searchQuery.trim()}'`"
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
      <template #col-folderName="{ item: file }">
        <div class="min-w-0 text-xs text-theme-400">
          <div class="truncate">
            {{ file.folderName }}
          </div>
          <div
            v-if="file.folderPath && file.folderPath !== file.folderName"
            class="truncate text-[10px] text-theme-600"
          >
            {{ file.folderPath }}
          </div>
        </div>
      </template>
      <template #col-modifiedAt="{ item: file }">
        <span class="text-xs text-theme-500">{{ new Date(file.modifiedAt).toLocaleDateString() }}</span>
      </template>
      <template #col-similarity="{ item: file }">
        <span
          class="inline-flex rounded-full border border-accent-500/25 bg-accent-500/10 px-2 py-0.5 text-xs font-medium text-accent-300"
          :title="`Best chunk cosine similarity: ${((file.similarity || 0) * 100).toFixed(1)}%`"
        >
          {{ Math.round((file.similarity || 0) * 100) }}%
        </span>
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
      v-else-if="files.length === 0 && childFolders.length === 0 && !filesLoading"
      class="rounded-xl border border-theme-800 bg-theme-950/45 text-center py-10 text-theme-500 text-sm"
    >
      No files in this folder yet. Upload files to get started.
    </div>
    <!-- Grid explorer -->
    <div
      v-else-if="explorerView === 'grid'"
      class="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3"
      data-testid="memory-explorer-grid"
    >
      <div
        v-for="folder in childFolders"
        :key="folder.id"
        role="button"
        tabindex="0"
        class="group relative flex min-h-36 flex-col items-center justify-center rounded-xl border border-theme-800 bg-theme-950/45 p-4 text-center transition hover:border-theme-700 hover:bg-theme-800/30"
        :class="[
          highlightedFolderId === folder.id || selectedFolders.has(folder.id) ? 'border-accent-500/50 bg-accent-500/[0.08]' : '',
          dropTargetFolderId === folder.id ? 'border-accent-500/60 bg-accent-500/10 ring-1 ring-accent-500/50' : '',
        ]"
        @click="openFolder(folder)"
        @keydown.enter="openFolder(folder)"
        @dblclick="openFolder(folder)"
        @contextmenu="openContextMenu('folder', $event, folder)"
        @dragover="onFolderDocumentDragOver(folder, $event)"
        @dragleave="onFolderDocumentDragLeave(folder, $event)"
        @drop="onFolderDocumentDrop(folder, $event)"
      >
        <input
          type="checkbox"
          class="absolute left-3 top-3 h-4 w-4 cursor-pointer rounded border-theme-600 bg-theme-900 text-accent-500 opacity-100 transition-opacity focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          :class="{ 'sm:!opacity-100': selectedItemCount > 0 || selectedFolders.has(folder.id) }"
          :checked="selectedFolders.has(folder.id)"
          :aria-label="`${selectedFolders.has(folder.id) ? 'Deselect' : 'Select'} ${folder.name}`"
          @click.stop="toggleGridSelection(rowForFolder(folder), $event)"
        >
        <Icon
          :icon="folder.autoMemoryExcluded ? 'lucide:folder-x' : 'lucide:folder'"
          class="mb-3 h-11 w-11"
          :class="folder.autoMemoryExcluded ? 'text-orange-400' : 'text-amber-400'"
        />
        <span class="w-full truncate text-sm font-medium text-theme-200">{{ folder.name }}</span>
        <span class="mt-1 text-[11px] text-theme-600">{{ folder.fileCount }} file{{ folder.fileCount !== 1 ? 's' : '' }}</span>
      </div>
      <div
        v-for="file in filteredFiles"
        :key="file.fileName"
        :draggable="true"
        role="button"
        tabindex="0"
        class="group relative flex min-h-36 flex-col items-center justify-center rounded-xl border border-theme-800 bg-theme-950/45 p-4 text-center transition hover:border-theme-700 hover:bg-theme-800/30"
        :class="[
          selectedFiles.has(file.fileName) ? 'border-accent-500/50 bg-accent-500/[0.08]' : '',
          !file.supported ? 'opacity-50' : '',
        ]"
        @click="openEditorModal(file.fileName)"
        @dblclick="openEditorModal(file.fileName)"
        @keydown.enter="openEditorModal(file.fileName)"
        @contextmenu="openContextMenu('document', $event, file)"
        @dragstart.stop="startDocumentDrag($event, file.fileName)"
        @dragend="endDocumentDrag"
      >
        <input
          v-if="file.supported"
          type="checkbox"
          class="absolute left-3 top-3 h-4 w-4 cursor-pointer rounded border-theme-600 bg-theme-900 text-accent-500 opacity-100 transition-opacity focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          :class="{ 'sm:!opacity-100': selectedItemCount > 0 || selectedFiles.has(file.fileName) }"
          :checked="selectedFiles.has(file.fileName)"
          :aria-label="`${selectedFiles.has(file.fileName) ? 'Deselect' : 'Select'} ${file.fileName}`"
          @click.stop="toggleGridSelection(rowForFile(file), $event)"
        >
        <Icon
          :icon="file.extension === '.md' ? 'lucide:file-text' : file.extension === '.pdf' ? 'lucide:file-type-2' : 'lucide:file'"
          class="mb-3 h-10 w-10"
          :class="hasRecentDreamUpdate(file) ? 'text-violet-400' : file.supported ? 'text-theme-400' : 'text-theme-600'"
        />
        <span class="w-full truncate text-sm font-medium text-theme-200">{{ file.fileName }}</span>
        <span class="mt-1 text-[11px] text-theme-600">{{ formatFileSize(file.size) }}</span>
        <span
          class="mt-2 inline-flex items-center gap-1 text-[10px]"
          :class="file.status === 'indexed' ? 'text-green-400' : 'text-theme-500'"
        >
          <Icon
            :icon="statusIcon(file.status)"
            class="h-3 w-3"
          />
          {{ statusLabel(file.status) }}
        </span>
      </div>
    </div>
    <!-- Unified sortable folder/file list -->
    <DataTable
      v-else
      v-model:selected-ids="selectedExplorerIds"
      v-model:page="page"
      :items="documentRows"
      :columns="columns"
      :selectable="true"
      :row-selectable="isExplorerRowSelectable"
      :row-clickable="true"
      :row-draggable="(item) => item.kind === 'file'"
      :row-class="(item) => item.kind === 'folder' ? (dropTargetFolderId === item.folder.id ? 'bg-accent-500/10 ring-1 ring-inset ring-accent-500/60' : 'cursor-pointer') : !item.supported ? 'opacity-50' : 'cursor-pointer'"
      :pagination="true"
      :page-size="FILES_PAGE_SIZE"
      pagination-position="both"
      initial-sort-key="name"
      initial-sort-direction="asc"
      empty-message="No folders or files here yet."
      @row-click="openExplorerRow"
      @row-contextmenu="openExplorerContextMenu"
      @row-dragstart="startExplorerDrag"
      @row-dragover="dragOverExplorerRow"
      @row-dragleave="dragLeaveExplorerRow"
      @row-drop="dropOnExplorerRow"
      @row-dragend="endDocumentDrag"
      @visible-items-change="visibleDocumentRows = $event"
    >
      <template #col-name="{ item }">
        <div class="flex min-w-0 items-center gap-3">
          <Icon
            :icon="item.kind === 'folder'
              ? item.folder.autoMemoryExcluded ? 'lucide:folder-x' : 'lucide:folder'
              : item.extension === '.md' ? 'lucide:file-text' : item.extension === '.pdf' ? 'lucide:file-type-2' : 'lucide:file'"
            class="h-5 w-5 shrink-0"
            :class="item.kind === 'folder'
              ? item.folder.autoMemoryExcluded ? 'text-orange-400' : 'text-amber-400'
              : item.supported ? 'text-theme-400' : 'text-theme-600'"
          />
          <div class="min-w-0">
            <div class="truncate text-sm font-medium text-theme-200">
              {{ item.name }}
            </div>
            <div class="mt-0.5 truncate text-[11px] text-theme-600">
              <template v-if="item.kind === 'folder'">
                {{ item.folder.fileCount }} direct · {{ item.folder.descendantFileCount || 0 }} nested
              </template>
              <template v-else>
                {{ formatFileSize(item.size) }}<template v-if="item.tags.length">
                  · {{ item.tags.slice(0, 4).join(', ') }}
                </template>
              </template>
            </div>
          </div>
        </div>
      </template>
      <template #col-modifiedAt="{ item }">
        <span class="text-xs text-theme-500">
          {{ new Date(item.modifiedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }}
        </span>
      </template>
      <template #col-chunkCount="{ item }">
        <span class="text-xs text-theme-400">
          <template v-if="item.kind === 'folder'">{{ item.chunkCount || 0 }} items</template>
          <template v-else-if="item.status === 'indexed'">{{ item.chunkCount || 0 }}</template>
          <template v-else-if="item.estimatedChunkCount !== undefined">~{{ item.estimatedChunkCount }}</template>
          <template v-else>—</template>
        </span>
      </template>
      <template #col-deepResearched="{ item }">
        <span
          v-if="item.kind === 'folder'"
          class="text-xs text-theme-600"
        >Recursive</span>
        <span
          v-else
          class="inline-flex items-center gap-1.5 text-xs"
          :class="item.deepResearched ? 'text-green-400' : 'text-theme-500'"
        >
          <Icon
            :icon="item.deepResearched ? 'lucide:check-circle' : 'lucide:circle-dashed'"
            class="h-3.5 w-3.5"
          />
          {{ item.deepResearched ? 'Researched' : 'Not researched' }}
        </span>
      </template>
      <template #col-status="{ item }">
        <span
          v-if="item.kind === 'folder'"
          class="inline-flex items-center gap-1.5 text-xs text-amber-400"
        >
          <Icon
            icon="lucide:folder"
            class="h-3.5 w-3.5"
          /> Folder
        </span>
        <span
          v-else
          class="inline-flex items-center gap-1.5 text-xs"
          :class="item.status === 'indexed' ? 'text-green-400' : 'text-theme-500'"
        >
          <Icon
            :icon="statusIcon(item.status)"
            class="h-3.5 w-3.5"
          />
          {{ statusLabel(item.status) }}
        </span>
      </template>
    </DataTable>


    <Teleport to="body">
      <div
        v-if="contextMenu"
        data-memory-context-menu
        data-testid="memory-explorer-context-menu"
        class="fixed z-[80] w-60 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-2xl shadow-black/50"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        role="menu"
        @contextmenu.prevent
      >
        <template v-if="contextMenu.kind === 'folder' && contextMenu.folder">
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
            role="menuitem"
            @click="openFolder(contextMenu.folder)"
          >
            <Icon
              icon="lucide:folder-open"
              class="h-3.5 w-3.5 text-amber-400"
            /> Open
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
            role="menuitem"
            @click="emit('createFolder', contextMenu.folder); closeContextMenu()"
          >
            <Icon
              icon="lucide:folder-plus"
              class="h-3.5 w-3.5 text-accent-400"
            /> Add subfolder
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
            role="menuitem"
            @click="emit('editFolder', contextMenu.folder); closeContextMenu()"
          >
            <Icon
              icon="lucide:settings-2"
              class="h-3.5 w-3.5"
            /> Folder settings
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
            role="menuitem"
            @click="emit('toggleAutoMemoryExclusion', contextMenu.folder); closeContextMenu()"
          >
            <Icon
              :icon="contextMenu.folder.autoMemoryExcluded ? 'lucide:folder-check' : 'lucide:folder-x'"
              class="h-3.5 w-3.5"
              :class="contextMenu.folder.autoMemoryExcluded ? 'text-emerald-400' : 'text-orange-400'"
            />
            {{ contextMenu.folder.autoMemoryExcluded ? 'Include in Auto Memory Router' : 'Exclude from Auto Memory Router' }}
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-left text-xs text-red-300 hover:bg-red-500/10"
            role="menuitem"
            @click="emit('deleteFolder', contextMenu.folder); closeContextMenu()"
          >
            <Icon
              icon="lucide:trash-2"
              class="h-3.5 w-3.5"
            /> Delete folder
          </button>
        </template>
        <template v-else-if="contextMenu.kind === 'document' && contextMenu.file">
          <div class="border-b border-theme-800 px-3 py-2 text-[11px] text-theme-500">
            {{ selectedItemCount }} item{{ selectedItemCount !== 1 ? 's' : '' }} selected
          </div>
          <button
            v-if="selectedItemCount === 1 && selectedFiles.size === 1 && contextMenu.file.textDirect"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
            role="menuitem"
            @click="openEditorModal(contextMenu.file.fileName); closeContextMenu()"
          >
            <Icon
              icon="lucide:file-pen-line"
              class="h-3.5 w-3.5"
            /> Open
          </button>
          <button
            v-if="spaces.length > 1 && selectedItemCount > 0"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
            role="menuitem"
            @click="showMoveDialog = true; closeContextMenu()"
          >
            <Icon
              icon="lucide:folder-input"
              class="h-3.5 w-3.5 text-accent-400"
            /> Move
          </button>
          <button
            v-if="selectedSearchIndexFiles.length > 0 || selectedFolders.size > 0"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-orange-300 hover:bg-orange-500/10"
            role="menuitem"
            @click="makeSearchableSelected(); closeContextMenu()"
          >
            <Icon
              icon="lucide:search-check"
              class="h-3.5 w-3.5"
            /> Index files
          </button>
          <button
            v-if="selectedDeepResearchFiles.length > 0 || selectedFolders.size > 0"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-emerald-300 hover:bg-emerald-500/10"
            role="menuitem"
            @click="deepResearchSelected(); closeContextMenu()"
          >
            <Icon
              icon="lucide:network"
              class="h-3.5 w-3.5"
            /> Deep Research
          </button>
          <button
            v-if="selectedRememberedFiles.length > 0 || selectedFolders.size > 0"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-orange-300 hover:bg-orange-500/10"
            role="menuitem"
            @click="forgetSelectedMemories(); closeContextMenu()"
          >
            <Icon
              icon="lucide:brain-circuit"
              class="h-3.5 w-3.5"
            /> Drop Index
          </button>
          <button
            v-if="selectedItemCount > 0"
            type="button"
            class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-left text-xs text-red-300 hover:bg-red-500/10"
            role="menuitem"
            @click="deleteSelectedFiles(); closeContextMenu()"
          >
            <Icon
              icon="lucide:trash-2"
              class="h-3.5 w-3.5"
            /> Remove
          </button>
        </template>
      </div>
    </Teleport>

    <MemoryDocumentEditorModal
      :show="showEditorModal"
      :folder-id="folderId"
      :source-file="editorFileName"
      @close="showEditorModal = false"
      @saved="handleEditorSaved"
    />

    <ModalDialog
      :show="showLargeChunkWarning"
      title="Index a large document?"
      icon="lucide:triangle-alert"
      icon-color="amber"
      @close="cancelLargeIndex"
    >
      <div class="space-y-3 text-sm leading-relaxed text-theme-400">
        <p>
          {{ largeChunkWarningFiles.length === 1
            ? `${largeChunkWarningFiles[0]?.fileName} is estimated to produce ${estimatedChunks(largeChunkWarningFiles[0]!)} chunks.`
            : `${largeChunkWarningFiles.length} selected files are each estimated to produce more than ${LARGE_CHUNK_WARNING_THRESHOLD} chunks.` }}
        </p>
        <p>
          Very large documents can dominate search results simply because they contribute so many chunks. They also take longer to embed and may increase embedding costs and storage use.
        </p>
        <p class="text-theme-300">
          You can continue anyway if this is intentional.
        </p>
      </div>
      <template #actions>
        <button
          type="button"
          class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500"
          @click="confirmLargeIndex"
        >
          Index anyway
        </button>
        <button
          type="button"
          class="px-4 py-2 text-sm text-theme-400 transition-colors hover:text-theme-200"
          @click="cancelLargeIndex"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>

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
      :source-folder-id="folderId"
      :selected-count="selectedItemCount"
      :spaces="moveTargetSpaces"
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
