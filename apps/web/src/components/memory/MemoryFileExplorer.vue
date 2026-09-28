<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, toRef, watch } from "vue";
import { api } from "../../api/client";
import { RUNTIME_LIMITS } from "@shared/runtime-limits";
import type { MemoryFolder, MemoryFileStatus, MemoryFileSearchResult, MemoryIndexJob } from "../../api/types";
import { Icon } from "@iconify/vue";
import MemoryDocumentEditorModal from "./MemoryDocumentEditorModal.vue";
import type { Column } from "../shared/DataTable.vue";
import { useMemoryDocumentJobs } from "../../composables/useMemoryDocumentJobs";
import MemoryDocumentMoveDialog from "./MemoryDocumentMoveDialog.vue";
import MemoryExplorerHeader from "./MemoryExplorerHeader.vue";
import MemoryExplorerContextMenu from "./MemoryExplorerContextMenu.vue";
import MemoryExplorerBrowser from "./MemoryExplorerBrowser.vue";
import MemoryExplorerSearchStatus from "./MemoryExplorerSearchStatus.vue";
import MemoryExplorerToolbar from "./MemoryExplorerToolbar.vue";
import MemoryLargeIndexWarning from "./MemoryLargeIndexWarning.vue";
import ModalDialog from "../shared/ModalDialog.vue";
import SplitButton from "../shared/SplitButton.vue";
import type {
  DocumentDragPayload,
  DocumentRow,
  ExplorerContextMenu,
  ExplorerRow,
  FolderRow,
  GlobalDocumentRow,
  UploadResult,
} from "./memory-file-explorer-types";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";

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
const trackedFolderJobs = ref<MemoryIndexJob[]>([]);
const trackedFolderBaselines = ref<Record<string, number>>({});
let folderJobPollTimer: ReturnType<typeof setInterval> | null = null;
let folderJobPollInFlight = false;
const gridSelectionAnchor = ref<string | null>(null);
const deleting = ref(false);
const forgettingMemories = ref(false);
const moving = ref(false);
const showMoveDialog = ref(false);
const moveContextFile = ref<MemoryFileStatus | null>(null);
const savedExplorerView = localStorage.getItem(EXPLORER_VIEW_KEY);
const explorerView = ref<"list" | "grid">(
  savedExplorerView === "grid" || savedExplorerView === "list"
    ? savedExplorerView
    : window.matchMedia("(max-width: 639px)").matches ? "grid" : "list",
);
const highlightedFolderId = ref<string | null>(null);
const dropTargetFolderId = ref<string | null>(null);
const activeDocumentDrag = ref<DocumentDragPayload | null>(null);
const contextMenu = ref<ExplorerContextMenu | null>(null);
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
const DREAM_INDICATOR_DURATION_MS = 24 * 60 * 60 * 1000;
const dreamIndicatorNow = ref(Date.now());
const dreamIndicatorTimer = window.setInterval(() => {
  dreamIndicatorNow.value = Date.now();
}, 60_000);

function hasRecentDreamUpdate(file: MemoryFileStatus): boolean {
  return Boolean(file.dreamedAt && dreamIndicatorNow.value - file.dreamedAt < DREAM_INDICATOR_DURATION_MS);
}

// Upload
const fileInput = ref<HTMLInputElement | null>(null);
const showNewFileDialog = ref(false);
const newFileName = ref("");
const newFileError = ref("");
const creatingFile = ref(false);
const uploading = ref(false);
const uploadProgress = ref({ current: 0, total: 0 });
const uploadResults = ref<UploadResult[]>([]);
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
const rootFolder = computed(() => props.spaces.find((space) => space.isUncategorized) || props.spaces[0]);
const folderHistory = ref<string[]>([props.folderId]);
const folderHistoryIndex = ref(0);
const canNavigateBack = computed(() => folderHistoryIndex.value > 0);
const canNavigateForward = computed(() => folderHistoryIndex.value < folderHistory.value.length - 1);
const pathCopied = ref(false);
let pathCopiedTimer: number | null = null;

const pathSegments = computed(() => {
  const path = currentSpace.value?.directoryPath || "";
  return path.split(/[\\/]+/).filter(Boolean).map((label, index, segments) => {
    const folderId = props.spaces.find((space) => {
      const candidate = (space.directoryPath || "").split(/[\\/]+/).filter(Boolean);
      return candidate.length === index + 1 && candidate.every((part, partIndex) => part === segments[partIndex]);
    })?.id;
    return { label, folderId };
  }).filter((segment): segment is { label: string; folderId: string } => Boolean(segment.folderId));
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

function navigateHome(): void {
  if (rootFolder.value && rootFolder.value.id !== props.folderId) emit("navigateFolder", rootFolder.value.id);
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
  else if (item.kind === "file") openContextMenu("document", event, item);
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
  return item.kind === "folder" || (item.kind === "file" && item.supported);
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
  const matching = q ? files.value.filter((f) =>
    f.fileName.toLowerCase().includes(q) || (f.tags || []).some((tag) => tag.includes(q)),
  ) : files.value;
  return [...matching].sort((a, b) => b.modifiedAt - a.modifiedAt || a.fileName.localeCompare(b.fileName));
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
  { key: "chunkCount", label: "Items / Chunks", minWidth: "90px", grow: 0, sortable: true, sortValue: (item) => item.kind !== "file" ? item.chunkCount : item.status === "indexed" ? (item.chunkCount || 0) : (item.estimatedChunkCount || 0) },
  { key: "deepResearched", label: "Deep Research", minWidth: "190px", sortable: true, sortValue: (item) => item.kind === "file" && item.deepResearched },
  {
    key: "status",
    label: "Indexed",
    minWidth: "220px",
    grow: 1.15,
    sortable: true,
    sortValue: (item) => item.kind === "folder" ? folderIndexSummary(item.folder).ratio : item.status === "indexed" ? 1 : 0,
  },
];

function explorerSortGroup(item: ExplorerRow): number {
  if (item.kind === "folder") return 0;
  return 1;
}

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
      : item.kind === "file" && selectedFiles.value.has(item.fileName));
  },
);
const selectedItemCount = computed(() => selectedFiles.value.size + selectedFolders.value.size);

const supportedFiles = computed(() => files.value.filter((f) => f.supported));
const needsAttentionCount = computed(
  () => supportedFiles.value.filter((f) => f.status === "needs_reindex" || f.status === "not_indexed").length,
);
const descendantNeedsAttentionCount = computed(() => {
  const current = currentSpace.value;
  if (!current) return 0;
  return Math.max(0, (current.descendantFileCount || 0) - (current.descendantIndexedFileCount || 0));
});
const recursiveNeedsAttentionCount = computed(() => needsAttentionCount.value + descendantNeedsAttentionCount.value);
const currentIndexLabel = computed(() => needsAttentionCount.value
  ? `Index all ${needsAttentionCount.value} ${needsAttentionCount.value === 1 ? "file" : "files"}`
  : "No files to index");
const recursiveIndexLabel = computed(() =>
  `Index all ${recursiveNeedsAttentionCount.value} ${recursiveNeedsAttentionCount.value === 1 ? "file" : "files"} including subfolders`);
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
  deepResearchProgress,
  searchIndexProgress,
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

async function reindexAllIncludingSubfolders(): Promise<void> {
  const currentPath = currentSpace.value?.folderPath;
  if (currentPath === undefined) return;
  const descendants = props.spaces.filter((folder) => folder.id !== props.folderId &&
    (currentPath ? folder.folderPath.startsWith(`${currentPath}/`) : Boolean(folder.folderPath)));
  const groups = await Promise.all(descendants.map(async (folder) => ({
    folderId: folder.id,
    files: await api.memoryFolders.listFiles(folder.id),
  })));
  const candidates = [files.value, ...groups.map((group) => group.files)]
    .flat().filter((file) => file.supported && (file.status === "needs_reindex" || file.status === "not_indexed"));
  await indexWithWarning(candidates, async () => {
    await reindexAllNow();
    for (const group of groups) {
      for (const file of group.files.filter((item) =>
        item.supported && (item.status === "needs_reindex" || item.status === "not_indexed"))) {
        trackFolderJob(await api.memoryFolders.startReindexFile(group.folderId, file.fileName));
      }
    }
  });
}

async function deepResearchSelected(targetFile?: MemoryFileStatus): Promise<void> {
  const groups = await resolveSelectedFileGroups(targetFile);
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

async function makeSearchableSelected(targetFile?: MemoryFileStatus): Promise<void> {
  const groups = await resolveSelectedFileGroups(targetFile);
  const candidates = [...groups.values()].flat().filter((file) =>
    file.supported && (file.status === "needs_reindex" || file.status === "not_indexed"),
  );
  await indexWithWarning(candidates, async () => {
    for (const [folderId, groupFiles] of groups) {
      for (const file of groupFiles.filter((candidate) =>
        candidate.supported && (candidate.status === "needs_reindex" || candidate.status === "not_indexed"),
      )) {
        if (folderId === props.folderId) await reindexFile(file.fileName);
        else trackFolderJob(await api.memoryFolders.startReindexFile(folderId, file.fileName));
      }
    }
  });
}

function folderContainsJob(folder: MemoryFolder, job: MemoryIndexJob): boolean {
  const jobFolder = props.spaces.find((candidate) => candidate.id === job.folderId);
  return Boolean(jobFolder && (jobFolder.id === folder.id ||
    (folder.folderPath && jobFolder.folderPath.startsWith(`${folder.folderPath}/`))));
}

function stopFolderJobPolling(): void {
  if (folderJobPollTimer !== null) clearInterval(folderJobPollTimer);
  folderJobPollTimer = null;
}

function trackFolderJob(job: MemoryIndexJob): void {
  for (const folder of childFolders.value.filter((candidate) => folderContainsJob(candidate, job))) {
    if (trackedFolderBaselines.value[folder.id] === undefined) {
      trackedFolderBaselines.value = {
        ...trackedFolderBaselines.value,
        [folder.id]: (folder.indexedFileCount || 0) + (folder.descendantIndexedFileCount || 0),
      };
    }
  }
  trackedFolderJobs.value = [...trackedFolderJobs.value.filter((item) => item.id !== job.id), job];
  if (job.status === "completed") emit("spacesChanged");
  if (!folderJobPollTimer && trackedFolderJobs.value.some(isActiveFolderJob)) {
    folderJobPollTimer = setInterval(() => void refreshTrackedFolderJobs(), 2000);
  }
}

function isActiveFolderJob(job: MemoryIndexJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "retrying";
}

async function refreshTrackedFolderJobs(): Promise<void> {
  if (folderJobPollInFlight) return;
  const folderIds = [...new Set(trackedFolderJobs.value.filter(isActiveFolderJob).map((job) => job.folderId))];
  if (!folderIds.length) {
    stopFolderJobPolling();
    return;
  }
  folderJobPollInFlight = true;
  try {
    const jobLists = await Promise.all(folderIds.map((id) => api.memoryFolders.listJobs(id)));
    const latestJobs = new Map(jobLists.flat().map((job) => [job.id, job]));
    let completed = false;
    trackedFolderJobs.value = trackedFolderJobs.value.map((job) => {
      const latest = latestJobs.get(job.id) || job;
      if (isActiveFolderJob(job) && latest.status === "completed") completed = true;
      return latest;
    });
    if (completed) emit("spacesChanged");
    if (!trackedFolderJobs.value.some(isActiveFolderJob)) stopFolderJobPolling();
  } catch {
    // Keep polling while jobs remain active; the next response is authoritative.
  } finally {
    folderJobPollInFlight = false;
  }
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

async function resolveSelectedFileGroups(targetFile?: MemoryFileStatus): Promise<Map<string, MemoryFileStatus[]>> {
  const groups = new Map<string, MemoryFileStatus[]>();
  if (targetFile) {
    groups.set(props.folderId, [targetFile]);
    return groups;
  }
  const direct = files.value.filter((file) => selectedFiles.value.has(file.fileName));
  if (direct.length) groups.set(props.folderId, direct);
  await Promise.all(selectedFolderScope().map(async (folder) => {
    const folderFiles = await api.memoryFolders.listFiles(folder.id);
    if (folderFiles.length) groups.set(folder.id, folderFiles);
  }));
  return groups;
}

const moveTargetSpaces = computed(() => {
  if (moveContextFile.value) return props.spaces.filter((candidate) => candidate.id !== props.folderId);
  const selected = props.spaces.filter((folder) => selectedFolders.value.has(folder.id));
  return props.spaces.filter((candidate) => candidate.id !== props.folderId && !selected.some((folder) =>
    candidate.id === folder.id || Boolean(folder.folderPath && candidate.folderPath.startsWith(`${folder.folderPath}/`)),
  ));
});

// --- Bulk removal ---
async function deleteSelectedFiles(targetFile?: MemoryFileStatus) {
  if (!targetFile && selectedItemCount.value === 0) return;
  deleting.value = true;
  try {
    if (targetFile) {
      await api.memoryFolders.deleteDocuments(props.folderId, [targetFile.fileName]);
    } else if (selectedFiles.value.size) {
      await api.memoryFolders.deleteDocuments(props.folderId, Array.from(selectedFiles.value));
    }
    if (!targetFile) {
      for (const folder of props.spaces.filter((item) => selectedFolders.value.has(item.id))) {
        await api.memoryFolders.remove(folder.id);
      }
    }
    const deleted = targetFile ? new Set([targetFile.fileName]) : selectedFiles.value;
    if (targetFile) {
      selectedFiles.value = new Set([...selectedFiles.value].filter((fileName) => fileName !== targetFile.fileName));
    } else {
      clearSelection();
    }
    files.value = files.value.filter((file) => !deleted.has(file.fileName));
    emit("spacesChanged");
  } catch {
    /* error */
  }
  deleting.value = false;
}

async function forgetSelectedMemories(targetFile?: MemoryFileStatus) {
  const groups = await resolveSelectedFileGroups(targetFile);
  if (groups.size === 0) return;
  forgettingMemories.value = true;
  try {
    for (const [folderId, groupFiles] of groups) {
      const sourceFiles = groupFiles
        .filter((file) => file.status !== "not_indexed" || file.deepResearched)
        .map((file) => file.fileName);
      if (sourceFiles.length) await api.memoryFolders.forgetMemories(folderId, sourceFiles);
    }
    if (!targetFile) clearSelection();
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
  const targetFile = moveContextFile.value;
  if ((!targetFile && selectedItemCount.value === 0) || targetFolderId === props.folderId) return;
  const target = props.spaces.find((folder) => folder.id === targetFolderId);
  if (!target) return;
  moving.value = true;
  try {
    if (targetFile) {
      await api.memoryFolders.moveDocuments(props.folderId, [targetFile.fileName], targetFolderId);
    } else if (selectedFiles.value.size) {
      await api.memoryFolders.moveDocuments(props.folderId, Array.from(selectedFiles.value), targetFolderId);
    }
    if (!targetFile) {
      for (const folder of props.spaces.filter((item) => selectedFolders.value.has(item.id))) {
        const folderPath = target.folderPath ? `${target.folderPath}/${folder.name}` : folder.name;
        await api.memoryFolders.update(folder.id, { folderPath });
      }
    }
    const moved = targetFile ? new Set([targetFile.fileName]) : selectedFiles.value;
    if (targetFile) {
      selectedFiles.value = new Set([...selectedFiles.value].filter((fileName) => fileName !== targetFile.fileName));
    } else {
      clearSelection();
    }
    files.value = files.value.filter((file) => !moved.has(file.fileName));
    showMoveDialog.value = false;
    moveContextFile.value = null;
    emit("spacesChanged");
  } catch {
    /* error */
  }
  moving.value = false;
}

function openContextMove(file: MemoryFileStatus): void {
  moveContextFile.value = file;
  showMoveDialog.value = true;
  closeContextMenu();
}

function closeMoveDialog(): void {
  showMoveDialog.value = false;
  moveContextFile.value = null;
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

function openNewFileDialog(): void {
  newFileName.value = "Untitled.md";
  newFileError.value = "";
  showNewFileDialog.value = true;
}

async function createFile(): Promise<void> {
  if (creatingFile.value) return;
  const name = newFileName.value.trim();
  if (!name || name.includes("/") || name.includes("\\")) {
    newFileError.value = "Enter a file name without a path.";
    return;
  }
  const fileName = /\.(md|txt)$/i.test(name) ? name : `${name}.md`;
  creatingFile.value = true;
  newFileError.value = "";
  try {
    const folderId = props.folderId;
    const result = await api.memoryFolders.ingestFile(folderId, fileName, "");
    showNewFileDialog.value = false;
    emit("spacesChanged");
    if (props.folderId === folderId) {
      searchQuery.value = "";
      page.value = 0;
      await loadFiles();
      openDocument(result.fileName);
    }
  } catch (err) {
    newFileError.value = (err as Error).message || "Failed to create file";
  } finally {
    creatingFile.value = false;
  }
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

function folderIndexSummary(folder: MemoryFolder): {
  label: string;
  icon: string;
  colorClass: string;
  ratio: number;
} {
  const total = folder.fileCount + (folder.descendantFileCount || 0);
  const folderJobs = trackedFolderJobs.value.filter((job) => job.kind === "reindex" && folderContainsJob(folder, job));
  const completedFiles = new Set(folderJobs.filter((job) => job.status === "completed")
    .map((job) => `${job.folderId}\0${job.fileName}`));
  const indexed = Math.min(total, Math.max(
    (folder.indexedFileCount || 0) + (folder.descendantIndexedFileCount || 0),
    (trackedFolderBaselines.value[folder.id] || 0) + completedFiles.size,
  ));
  if (folderJobs.some(isActiveFolderJob)) {
    return {
      label: `${indexed}/${total} Partially Indexed · Indexing…`,
      icon: "lucide:loader-2",
      colorClass: "text-orange-400",
      ratio: total ? indexed / total : 0,
    };
  }
  if (total > 0 && indexed >= total) {
    return { label: "Indexed", icon: "lucide:check-circle", colorClass: "text-status-green", ratio: 1 };
  }
  if (indexed > 0) {
    return {
      label: `${indexed}/${total} Partially Indexed`,
      icon: "lucide:alert-circle",
      colorClass: "text-status-warning",
      ratio: indexed / total,
    };
  }
  return { label: "Not Indexed", icon: "lucide:circle-dashed", colorClass: "text-ink-muted", ratio: 0 };
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
    stopFolderJobPolling();
    trackedFolderJobs.value = [];
    trackedFolderBaselines.value = {};
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
  stopFolderJobPolling();
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
    <MemoryExplorerHeader
      :segments="pathSegments.map((segment) => ({ label: segment.label, disabled: segment.folderId === folderId }))"
      :home-disabled="!rootFolder || rootFolder.id === folderId"
      :can-go-back="canNavigateBack"
      :can-go-forward="canNavigateForward"
      @home="navigateHome"
      @back="navigateHistory(-1)"
      @forward="navigateHistory(1)"
      @segment-click="navigateBreadcrumb(pathSegments[$event]?.folderId)"
    >
      <template #path-actions>
        <button
          type="button"
          class="ml-1 shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200"
          :title="pathCopied ? 'Path copied' : 'Copy folder path'"
          aria-label="Copy current folder path"
          @click="copyCurrentFolderPath"
        >
          <Icon
            :icon="pathCopied ? 'lucide:check' : 'lucide:clipboard'"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          type="button"
          :disabled="currentSpace?.isUncategorized"
          :title="currentSpace?.isUncategorized ? 'Cannot edit memory root' : 'Edit folder'"
          :aria-label="currentSpace?.isUncategorized ? 'Memory root cannot be edited' : `Edit ${currentSpace?.name || 'folder'}`"
          class="shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200 disabled:cursor-not-allowed disabled:opacity-30"
          @click="emit('editSpace')"
        >
          <Icon
            icon="lucide:pencil"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          type="button"
          :disabled="currentSpace?.isUncategorized"
          :title="currentSpace?.isUncategorized ? 'Cannot remove Uncategorized' : 'Remove folder'"
          :aria-label="currentSpace?.isUncategorized ? 'Uncategorized memory cannot be removed' : `Remove ${currentSpace?.name || 'folder'}`"
          class="shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-theme-800 hover:text-status-danger disabled:cursor-not-allowed disabled:opacity-30"
          @click="emit('deleteSpace')"
        >
          <Icon
            icon="lucide:trash-2"
            class="h-3.5 w-3.5"
          />
        </button>
      </template>
      <template #actions>
        <button
          v-if="currentSpace"
          type="button"
          class="flex items-center gap-2 rounded-lg border border-theme-800 bg-theme-900/60 px-3 py-1.5 text-sm text-theme-300 transition-colors hover:bg-theme-800/60"
          @click="openNewFileDialog"
        >
          <Icon
            icon="lucide:file-plus-2"
            class="h-4 w-4 text-accent-fg"
          />
          New file
        </button>
        <button
          v-if="currentSpace"
          type="button"
          class="flex items-center gap-2 rounded-lg border border-theme-800 bg-theme-900/60 px-3 py-1.5 text-sm text-theme-300 transition-colors hover:bg-theme-800/60"
          @click="emit('createFolder', currentSpace)"
        >
          <Icon
            icon="lucide:folder-plus"
            class="h-4 w-4 text-status-warning"
          />
          New folder
        </button>
        <SplitButton
          v-if="recursiveNeedsAttentionCount > 0"
          title="Indexing files makes them available for semantic searching."
          :primary-disabled="needsAttentionCount === 0"
          :primary-label="`${currentIndexLabel} in this folder`"
          menu-label="Indexing scope options"
          class="h-8 text-sm"
          @primary="reindexAll"
        >
          <Icon
            icon="lucide:refresh-cw"
            class="w-4 h-4"
          />
          {{ currentIndexLabel }}
          <template #menu="{ close }">
            <button
              type="button"
              role="menuitem"
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-theme-200 hover:bg-theme-800 focus:outline-none focus-visible:bg-theme-800"
              @click="close(); reindexAllIncludingSubfolders()"
            >
              <Icon
                icon="lucide:folders"
                class="h-4 w-4 shrink-0 text-accent-fg"
              />
              {{ recursiveIndexLabel }}
            </button>
          </template>
        </SplitButton>
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
      </template>
    </MemoryExplorerHeader>

    <MemoryExplorerSearchStatus
      v-model:query="searchQuery"
      v-model:semantic="semanticSearch"
      :description="currentSpace?.description"
      :search-loading="globalSearchLoading"
      :uploading="uploading"
      :upload-progress="uploadProgress"
      :upload-results="uploadResults"
      :failed-jobs="failedJobs"
      @search-input="page = 0"
      @clear-uploads="uploadResults = []"
      @dismiss-failure="dismissFailure"
      @dismiss-all-failures="dismissAllFailures"
    />

    <MemoryExplorerToolbar
      :view="explorerView"
      :searching="Boolean(searchQuery.trim())"
      :result-count="globalSearchResults.length"
      :folder-name="currentSpace?.name"
      :folder-count="childFolders.length"
      :file-count="files.length"
      :running-job-count="runningJobs.length"
      :selected-count="selectedItemCount"
      :row-count="documentRows.length"
      :filtered-file-count="filteredFiles.length"
      :all-selected="allFilteredSelected"
      :space-count="spaces.length"
      :selected-folder-count="selectedFolders.size"
      :can-index="selectedSearchIndexFiles.length > 0"
      :index-idle-count="selectedSearchIndexIdleCount"
      :can-research="selectedDeepResearchFiles.length > 0"
      :research-idle-count="selectedDeepResearchIdleCount"
      :can-forget="selectedRememberedFiles.length > 0"
      :moving="moving"
      :forgetting="forgettingMemories"
      :deleting="deleting"
      :files-loading="filesLoading"
      @update:view="setExplorerView"
      @select-page="selectAllOnPage"
      @select-all="selectAll"
      @move="showMoveDialog = true"
      @index="makeSearchableSelected()"
      @research="deepResearchSelected()"
      @forget="forgetSelectedMemories()"
      @remove="deleteSelectedFiles()"
      @clear-selection="clearSelection"
      @refresh="loadFiles"
    />

    <MemoryExplorerBrowser
      v-model:page="page"
      v-model:selected-ids="selectedExplorerIds"
      :search-query="searchQuery"
      :search-loading="globalSearchLoading"
      :search-rows="globalDocumentRows"
      :search-columns="searchColumns"
      :explorer-view="explorerView"
      :files="files"
      :files-loading="filesLoading"
      :child-folders="childFolders"
      :filtered-files="filteredFiles"
      :document-rows="documentRows"
      :columns="columns"
      :selected-files="selectedFiles"
      :selected-folders="selectedFolders"
      :selected-item-count="selectedItemCount"
      :highlighted-folder-id="highlightedFolderId"
      :drop-target-folder-id="dropTargetFolderId"
      :is-row-selectable="isExplorerRowSelectable"
      :sort-group="explorerSortGroup"
      :row-for-folder="rowForFolder"
      :row-for-file="rowForFile"
      :has-recent-dream-update="hasRecentDreamUpdate"
      :status-icon="statusIcon"
      :status-label="statusLabel"
      :folder-index-summary="folderIndexSummary"
      :format-file-size="formatFileSize"
      :is-job-active="isJobActive"
      :search-index-progress="searchIndexProgress"
      :deep-research-progress="deepResearchProgress"
      @open-global-result="openGlobalResult"
      @open-folder="openFolder"
      @open-document="openEditorModal"
      @open-context-menu="openContextMenu"
      @toggle-grid-selection="toggleGridSelection"
      @folder-drag-over="onFolderDocumentDragOver"
      @folder-drag-leave="onFolderDocumentDragLeave"
      @folder-drop="onFolderDocumentDrop"
      @document-drag-start="startDocumentDrag"
      @document-drag-end="endDocumentDrag"
      @row-click="openExplorerRow"
      @row-context-menu="openExplorerContextMenu"
      @row-drag-start="startExplorerDrag"
      @row-drag-over="dragOverExplorerRow"
      @row-drag-leave="dragLeaveExplorerRow"
      @row-drop="dropOnExplorerRow"
      @visible-items-change="visibleDocumentRows = $event"
    />

    <MemoryExplorerContextMenu
      :menu="contextMenu"
      :space-count="spaces.length"
      :supports-analysis="supportsAnalysis"
      @close="closeContextMenu"
      @open-folder="openFolder"
      @create-folder="emit('createFolder', $event)"
      @edit-folder="emit('editFolder', $event)"
      @toggle-auto-memory-exclusion="emit('toggleAutoMemoryExclusion', $event)"
      @delete-folder="emit('deleteFolder', $event)"
      @open-document="openEditorModal($event.fileName)"
      @move-document="openContextMove"
      @index-document="makeSearchableSelected"
      @research-document="deepResearchSelected"
      @forget-document="forgetSelectedMemories"
      @remove-document="deleteSelectedFiles"
    />

    <MemoryDocumentEditorModal
      :show="showEditorModal"
      :folder-id="folderId"
      :source-file="editorFileName"
      @close="showEditorModal = false"
      @saved="handleEditorSaved"
    />

    <ModalDialog
      :show="showNewFileDialog"
      title="New file"
      icon="lucide:file-plus-2"
      @close="!creatingFile && (showNewFileDialog = false)"
    >
      <form @submit.prevent="createFile">
        <label
          for="new-memory-file-name"
          class="mb-2 block text-sm text-theme-300"
        >File name</label>
        <input
          id="new-memory-file-name"
          v-model="newFileName"
          type="text"
          class="w-full rounded-lg border border-theme-700 bg-theme-950 px-3 py-2 text-sm text-theme-200 focus:outline-none focus:border-accent-500"
          :disabled="creatingFile"
        >
        <p class="mt-2 text-xs text-ink-muted">
          Files are created as Markdown unless you use a .txt extension.
        </p>
        <p
          v-if="newFileError"
          role="alert"
          class="mt-2 text-sm text-status-danger"
        >
          {{ newFileError }}
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-sm text-ink-secondary hover:bg-theme-800 hover:text-theme-200"
            :disabled="creatingFile"
            @click="showNewFileDialog = false"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded-lg accent-action bg-accent-500 px-3 py-2 text-sm font-medium text-accent-on hover:bg-accent-400 disabled:opacity-50"
            :disabled="creatingFile"
          >
            {{ creatingFile ? 'Creating…' : 'Create file' }}
          </button>
        </div>
      </form>
    </ModalDialog>

    <MemoryLargeIndexWarning
      :show="showLargeChunkWarning"
      :files="largeChunkWarningFiles"
      :threshold="LARGE_CHUNK_WARNING_THRESHOLD"
      @confirm="confirmLargeIndex"
      @cancel="cancelLargeIndex"
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
      :source-folder-id="folderId"
      :selected-count="moveContextFile ? 1 : selectedItemCount"
      :spaces="moveTargetSpaces"
      :moving="moving"
      @close="closeMoveDialog"
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
