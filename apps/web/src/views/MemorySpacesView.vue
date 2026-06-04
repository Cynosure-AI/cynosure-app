<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Handle, MarkerType, Position, VueFlow, useVueFlow, type Edge, type Node } from "@vue-flow/core";
import { NodeToolbar } from "@vue-flow/node-toolbar";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import { api } from "../api/client";
import type { EntityGraphEdge, EntityGraphNode, EntityGraphNodeType, EntityGraphResponse, MemorySpace } from "../api/types";
import { Icon } from "@iconify/vue";
import ModalDialog from "../components/shared/ModalDialog.vue";
import MemoryDocumentList from "../components/memory/MemoryDocumentList.vue";

const DOCUMENT_DRAG_MIME = "application/x-cynosure-memory-documents";
const COLLAPSED_KEY = "cy-memory-folder-collapsed";
const ENTITY_FLOW_ID = "memory-entity-graph";

const spaces = ref<MemorySpace[]>([]);
const spacesLoading = ref(false);
const selectedSpaceId = ref<string | null>(null);
const showCreateDialog = ref(false);
const editingSpace = ref<MemorySpace | null>(null);
const parentForCreate = ref<MemorySpace | null>(null);
const folderName = ref("");
const folderDescription = ref("");
const showDeleteConfirm = ref(false);
const pendingDeleteSpace = ref<MemorySpace | null>(null);
const collapsedFolders = ref<Set<string>>(readCollapsedFolders());
const activePanel = ref<"documents" | "relationships" | "visual">("documents");
const graph = ref<EntityGraphResponse | null>(null);
const graphLoading = ref(false);
const graphQuery = ref("");
const editingNode = ref<EntityGraphNode | null>(null);
const editingEdge = ref<EntityGraphEdge | null>(null);
const pendingDeleteNode = ref<EntityGraphNode | null>(null);
const pendingDeleteEdge = ref<EntityGraphEdge | null>(null);
const nodeName = ref("");
const nodeType = ref<EntityGraphNodeType>("other");
const nodeAliases = ref("");
const edgeRelation = ref("");
const edgeEvidence = ref("");
const edgeConfidence = ref(70);
const graphFlowNodes = ref<Node[]>([]);
const graphFlowEdges = ref<Edge[]>([]);

const docList = ref<InstanceType<typeof MemoryDocumentList> | null>(null);
const { fitView } = useVueFlow(ENTITY_FLOW_ID);
let elkPromise: Promise<InstanceType<typeof import("elkjs/lib/elk.bundled.js").default>> | null = null;

const ENTITY_NODE_TYPES: EntityGraphNodeType[] = [
  "person",
  "place",
  "organization",
  "project",
  "date",
  "technology",
  "concept",
  "other",
];

type FlowNodeData = {
  entity: EntityGraphNode;
  label: string;
  isSeed: boolean;
  connectedHandles: Set<string>;
};

type FlowPoint = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function getElk() {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  }
  return elkPromise;
}

const memorySections = [
  {
    id: "documents",
    label: "Documents",
    description: "Browse folders, upload files, and manage indexed memory documents.",
    icon: "lucide:file-text",
  },
  {
    id: "relationships",
    label: "Relationships",
    description: "Inspect, correct, and delete extracted entity connections.",
    icon: "lucide:git-branch",
  },
  {
    id: "visual",
    label: "Visual Graph",
    description: "Explore entities as a spatial graph with more room to breathe.",
    icon: "lucide:network",
  },
] as const;

const activeSection = computed(() =>
  memorySections.find((section) => section.id === activePanel.value) || memorySections[0],
);

const selectedSpace = computed(() =>
  spaces.value.find((s) => s.id === selectedSpaceId.value) || null,
);

const sortedSpaces = computed(() =>
  [...spaces.value].sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return (a.relativePath || "").localeCompare(b.relativePath || "");
  }),
);

const visibleSpaces = computed(() =>
  sortedSpaces.value.filter((space) => {
    if (space.isDefault) return true;
    const path = space.relativePath || "";
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (collapsedFolders.value.has(ancestor)) return false;
    }
    return true;
  }),
);

async function layoutGraph() {
  if (!graph.value) {
    graphFlowNodes.value = [];
    graphFlowEdges.value = [];
    return;
  }

  const nodeLabels = new Map<string, EntityGraphNode>();
  for (const node of graph.value.nodes) {
    nodeLabels.set(node.id, node);
  }
  for (const edge of graph.value.edges) {
    if (!nodeLabels.has(edge.fromNodeId)) nodeLabels.set(edge.fromNodeId, fallbackGraphNode(edge.fromNodeId, edge.fromName));
    if (!nodeLabels.has(edge.toNodeId)) nodeLabels.set(edge.toNodeId, fallbackGraphNode(edge.toNodeId, edge.toName));
  }

  const seedIds = new Set(graph.value.seedNodes.map((node) => node.id));
  const dimensions = new Map<string, { width: number; height: number }>(
    [...nodeLabels.entries()].map(([id, node]) => [id, nodeDimensions(node.name)]),
  );

  const elk = await getElk();
  const layout = await elk.layout({
    id: "entity-root",
    layoutOptions: {
      "elk.algorithm": "stress",
      "elk.stress.desiredEdgeLength": "280",
      "elk.spacing.nodeNode": "120",
      "elk.separateConnectedComponents": "true",
      "elk.disco.componentCompaction.strategy": "POLYOMINO",
      "elk.randomSeed": "7",
    },
    children: [...nodeLabels.entries()].map(([id]) => ({
      id,
      width: dimensions.get(id)?.width || 150,
      height: dimensions.get(id)?.height || 44,
    })),
    edges: graph.value.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.fromNodeId],
      targets: [edge.toNodeId],
    })),
  });

  const positions = new Map<string, { x: number; y: number }>((layout.children || []).map((child) => [
    child.id,
    { x: Math.round(child.x || 0), y: Math.round(child.y || 0) },
  ]));
  const points = new Map<string, FlowPoint>();
  for (const [id, position] of positions.entries()) {
    const size = dimensions.get(id) || { width: 150, height: 44 };
    points.set(id, { ...position, ...size });
  }

  const connectedHandles = new Map<string, Set<string>>();

  const edges: Edge[] = graph.value.edges.map((edge) => {
    const handles = closestHandles(points.get(edge.fromNodeId), points.get(edge.toNodeId));
    if (!connectedHandles.has(edge.fromNodeId)) connectedHandles.set(edge.fromNodeId, new Set());
    if (!connectedHandles.has(edge.toNodeId)) connectedHandles.set(edge.toNodeId, new Set());
    connectedHandles.get(edge.fromNodeId)!.add(handles.sourceHandle);
    connectedHandles.get(edge.toNodeId)!.add(handles.targetHandle);
    return {
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      label: formatRelation(edge.relation),
      markerEnd: MarkerType.ArrowClosed,
      class: "entity-flow-edge",
      style: { stroke: "#8b5cf6", strokeWidth: 1.8 },
      labelStyle: { fill: "#f3f4f6", fontSize: 11, fontWeight: 700 },
      labelBgStyle: { fill: "#111827", fillOpacity: 0.92 },
      labelBgPadding: [6, 4],
      labelBgBorderRadius: 4,
    };
  });

  const nodes: Node<FlowNodeData>[] = [...nodeLabels.entries()].map(([id, entity]) => ({
    id,
    type: "entity",
    position: positions.get(id) || { x: 0, y: 0 },
    class: seedIds.has(id) ? "entity-flow-node entity-flow-node-seed" : "entity-flow-node",
    data: { entity, label: entity.name, isSeed: seedIds.has(id), connectedHandles: connectedHandles.get(id) ?? new Set() },
  }));

  graphFlowNodes.value = nodes;
  graphFlowEdges.value = edges;
}

function fallbackGraphNode(id: string, name: string): EntityGraphNode {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    type: "other",
    aliases: [],
    mentionCount: 0,
    sourceCount: 0,
    firstSeenAt: 0,
    lastSeenAt: 0,
  };
}

function nodeDimensions(label: string): { width: number; height: number } {
  return {
    width: Math.max(150, Math.min(250, label.length * 8 + 54)),
    height: label.length > 18 ? 56 : 44,
  };
}

function closestHandles(source?: FlowPoint, target?: FlowPoint): { sourceHandle: string; targetHandle: string } {
  if (!source || !target) return { sourceHandle: "source-bottom", targetHandle: "target-top" };
  const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "source-right", targetHandle: "target-left" }
      : { sourceHandle: "source-left", targetHandle: "target-right" };
  }

  return dy >= 0
    ? { sourceHandle: "source-bottom", targetHandle: "target-top" }
    : { sourceHandle: "source-top", targetHandle: "target-bottom" };
}

watch([graph, () => activePanel.value], async () => {
  await layoutGraph();
  if (activePanel.value !== "visual" || graphFlowNodes.value.length === 0) return;
  await nextTick();
  window.setTimeout(() => {
    fitView({ padding: 0.18, duration: 320 }).catch(() => undefined);
  }, 40);
});

function hasChildren(space: MemorySpace): boolean {
  const prefix = space.relativePath ? `${space.relativePath}/` : "";
  return spaces.value.some((candidate) =>
    space.isDefault
      ? Boolean(candidate.relativePath)
      : candidate.relativePath?.startsWith(prefix),
  );
}

function isCollapsed(space: MemorySpace): boolean {
  return collapsedFolders.value.has(space.relativePath || "");
}

function readCollapsedFolders(): Set<string> {
  try {
    const raw = sessionStorage.getItem(COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedFolders(): void {
  try {
    sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedFolders.value]));
  } catch {
    /* ignore storage failures */
  }
}

function toggleFolder(space: MemorySpace) {
  const key = space.relativePath || "";
  const next = new Set(collapsedFolders.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedFolders.value = next;
  writeCollapsedFolders();
}

async function loadSpaces() {
  spacesLoading.value = true;
  try {
    const loaded = await api.memorySpaces.list();
    spaces.value = [...loaded].sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return (a.relativePath || "").localeCompare(b.relativePath || "");
    });
    if (!selectedSpaceId.value && spaces.value.length > 0) selectedSpaceId.value = spaces.value[0].id;
    if (selectedSpaceId.value && !spaces.value.some((s) => s.id === selectedSpaceId.value)) {
      selectedSpaceId.value = spaces.value[0]?.id || null;
    }
  } catch {
    spaces.value = [];
  }
  spacesLoading.value = false;
}

function openCreateDialog(parent?: MemorySpace) {
  editingSpace.value = null;
  parentForCreate.value = parent || selectedSpace.value;
  folderName.value = "";
  folderDescription.value = "";
  showCreateDialog.value = true;
}

function openEditDialog(space: MemorySpace) {
  editingSpace.value = space;
  parentForCreate.value = null;
  folderName.value = space.name;
  folderDescription.value = space.description;
  showCreateDialog.value = true;
}

function relativePathForName(space: MemorySpace, name: string): string {
  const trimmed = name.trim();
  if (space.isDefault) return "";
  const current = space.relativePath || "";
  const slash = current.lastIndexOf("/");
  return slash >= 0 ? `${current.slice(0, slash)}/${trimmed}` : trimmed;
}

async function saveFolder() {
  if (!folderName.value.trim()) return;
  try {
    if (editingSpace.value) {
      const data: { name?: string; description?: string; relativePath?: string } = {
        name: folderName.value.trim(),
        description: folderDescription.value,
      };
      if (!editingSpace.value.isDefault) data.relativePath = relativePathForName(editingSpace.value, folderName.value);
      const updated = await api.memorySpaces.update(editingSpace.value.id, data);
      selectedSpaceId.value = updated.id;
    } else {
      const created = await api.memorySpaces.create(
        folderName.value.trim(),
        folderDescription.value,
        parentForCreate.value?.relativePath || "",
      );
      selectedSpaceId.value = created.id;
    }
    await loadSpaces();
  } catch {
    /* surface errors later with shared notifications */
  }
  showCreateDialog.value = false;
}

function confirmDeleteSpace(space: MemorySpace) {
  pendingDeleteSpace.value = space;
  showDeleteConfirm.value = true;
}

async function deleteSpace(space: MemorySpace) {
  showDeleteConfirm.value = false;
  pendingDeleteSpace.value = null;
  try {
    await api.memorySpaces.remove(space.id);
    await loadSpaces();
  } catch {
    /* ignore */
  }
}

const dragCounter = ref(0);
const dropTargetSpaceId = ref<string | null>(null);

function onDragEnter(e: DragEvent, spaceId?: string) {
  if (activePanel.value !== "documents") return;
  e.preventDefault();
  if (spaceId) dropTargetSpaceId.value = spaceId;
  else dragCounter.value++;
}

function onDragLeave(e: DragEvent, spaceId?: string) {
  if (activePanel.value !== "documents") return;
  e.preventDefault();
  if (spaceId) {
    if (dropTargetSpaceId.value === spaceId) dropTargetSpaceId.value = null;
  } else {
    dragCounter.value = Math.max(0, dragCounter.value - 1);
  }
}

function onDragOver(e: DragEvent) {
  if (activePanel.value !== "documents") return;
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DOCUMENT_DRAG_MIME) ? "move" : "copy";
  }
}

async function onFolderDrop(e: DragEvent, targetSpaceId: string) {
  if (activePanel.value !== "documents") return;
  e.preventDefault();
  dropTargetSpaceId.value = null;
  const documentPayload = e.dataTransfer?.getData(DOCUMENT_DRAG_MIME);
  if (documentPayload) {
    try {
      const parsed = JSON.parse(documentPayload) as { sourceFiles?: unknown };
      const sourceFiles = Array.isArray(parsed.sourceFiles)
        ? parsed.sourceFiles.filter((value): value is string => typeof value === "string")
        : [];
      if (sourceFiles.length) await docList.value?.moveGroupsToSpace(targetSpaceId, sourceFiles);
    } catch {
      /* ignore malformed drag payload */
    }
    return;
  }
  await onFileDrop(e, targetSpaceId);
}

async function onFileDrop(e: DragEvent, targetSpaceId?: string) {
  if (activePanel.value !== "documents") return;
  e.preventDefault();
  dragCounter.value = 0;
  dropTargetSpaceId.value = null;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const spaceId = targetSpaceId || selectedSpaceId.value;
  if (!spaceId) return;
  if (spaceId !== selectedSpaceId.value) selectedSpaceId.value = spaceId;
  await nextTick();
  docList.value?.ingestFiles(Array.from(files));
}

onMounted(() => loadSpaces());

function formatRelation(relation: string): string {
  return relation.replace(/_/g, " ");
}

function formatDate(ts: number): string {
  if (!ts) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

async function loadGraph(query = graphQuery.value) {
  graphLoading.value = true;
  try {
    graph.value = await api.memory.getGraph(query.trim() || undefined, 100);
  } catch {
    graph.value = null;
  }
  graphLoading.value = false;
}

async function clearGraphWalk() {
  graphQuery.value = "";
  await loadGraph("");
}

async function selectPanel(panel: typeof activePanel.value) {
  activePanel.value = panel;
  if ((panel === "relationships" || panel === "visual") && !graph.value) await loadGraph();
}

function openEditNode(node: EntityGraphNode) {
  editingNode.value = node;
  nodeName.value = node.name;
  nodeType.value = node.type;
  nodeAliases.value = node.aliases.join(", ");
}

async function saveNode() {
  if (!editingNode.value || !nodeName.value.trim()) return;
  await api.memory.updateGraphNode(editingNode.value.id, {
    name: nodeName.value.trim(),
    type: nodeType.value,
    aliases: nodeAliases.value
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean),
  });
  editingNode.value = null;
  await loadGraph();
}

function confirmDeleteNode(node: EntityGraphNode) {
  pendingDeleteNode.value = node;
}

async function deleteNode(node: EntityGraphNode) {
  pendingDeleteNode.value = null;
  await api.memory.deleteGraphNode(node.id);
  await loadGraph();
}

function openEditEdge(edge: EntityGraphEdge) {
  editingEdge.value = edge;
  edgeRelation.value = edge.relation;
  edgeEvidence.value = edge.evidence || "";
  edgeConfidence.value = Math.round((edge.confidence || 0.7) * 100);
}

async function saveEdge() {
  if (!editingEdge.value || !edgeRelation.value.trim()) return;
  await api.memory.updateGraphEdge(editingEdge.value.id, {
    relation: edgeRelation.value.trim(),
    evidence: edgeEvidence.value,
    confidence: edgeConfidence.value / 100,
  });
  editingEdge.value = null;
  await loadGraph();
}

function confirmDeleteEdge(edge: EntityGraphEdge) {
  pendingDeleteEdge.value = edge;
}

async function deleteEdge(edge: EntityGraphEdge) {
  pendingDeleteEdge.value = null;
  await api.memory.deleteGraphEdge(edge.id);
  await loadGraph();
}
</script>

<template>
  <div
    class="h-full overflow-y-auto relative"
    @dragenter="onDragEnter($event)"
    @dragleave="onDragLeave($event)"
    @dragover="onDragOver($event)"
    @drop="onFileDrop($event)"
  >
    <div
      v-if="activePanel === 'documents' && dragCounter > 0 && selectedSpaceId && !dropTargetSpaceId"
      class="absolute inset-0 z-40 flex items-center justify-center bg-accent-500/10 border-2 border-dashed border-accent-500/40 rounded-xl pointer-events-none"
    >
      <div class="text-center">
        <Icon
          icon="lucide:upload-cloud"
          class="w-12 h-12 text-accent-400 mx-auto mb-2"
        />
        <p class="text-accent-300 font-medium">
          Drop files into {{ selectedSpace?.name || "selected folder" }}
        </p>
      </div>
    </div>

    <div class="flex min-h-full flex-col lg:flex-row">
      <aside class="shrink-0 border-b border-theme-800 bg-theme-950/60 lg:w-72 lg:border-b-0 lg:border-r">
        <header class="p-4">
          <h1 class="text-2xl font-bold text-theme-100">
            Memory
          </h1>
          <p class="mt-1 text-sm leading-relaxed text-theme-500">
            Manage documents, extracted relationships, and the entity graph.
          </p>
        </header>
        <nav class="flex gap-1 overflow-x-auto px-3 py-3 lg:block lg:space-y-1 lg:overflow-x-visible lg:p-4">
          <button
            v-for="section in memorySections"
            :key="section.id"
            class="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-all lg:w-full"
            :class="activePanel === section.id ? 'bg-theme-800 text-theme-100 shadow-[inset_3px_0_0_var(--color-accent-500,#3b82f6)]' : 'text-theme-400 hover:bg-theme-800/70 hover:text-theme-200'"
            @click="selectPanel(section.id)"
          >
            <Icon
              :icon="section.icon"
              class="h-4.5 w-4.5 shrink-0"
            />
            <span class="whitespace-nowrap">{{ section.label }}</span>
          </button>
        </nav>
      </aside>

      <main class="min-w-0 flex-1 overflow-y-auto">
        <div class="sticky top-0 z-10 border-b border-theme-800/60 bg-theme-950/95 backdrop-blur-sm px-4 py-3 sm:px-6 lg:px-8">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 class="text-xl font-semibold text-theme-100">
                {{ activeSection.label }}
              </h2>
              <p class="text-sm text-theme-500 mt-1">
                {{ activeSection.description }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                v-if="activePanel === 'documents'"
                class="px-3 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                @click="openCreateDialog()"
              >
                <Icon
                  icon="lucide:folder-plus"
                  class="w-4 h-4"
                />
                New Folder
              </button>
              <button
                v-if="activePanel === 'relationships' || activePanel === 'visual'"
                class="p-2 text-theme-500 hover:text-theme-200 transition-colors"
                title="Refresh entity graph"
                @click="loadGraph()"
              >
                <Icon
                  icon="lucide:refresh-cw"
                  class="w-4 h-4"
                  :class="{ 'animate-spin': graphLoading }"
                />
              </button>
            </div>
          </div>
        </div>

        <div
          v-if="spacesLoading && spaces.length === 0"
          class="flex items-center gap-2 py-8 justify-center text-theme-500"
        >
          <Icon
            icon="lucide:loader-2"
            class="w-5 h-5 animate-spin"
          />
          Loading folders...
        </div>

        <div
          v-else-if="activePanel === 'documents'"
          class="p-4 sm:p-6 lg:p-8"
        >
          <div class="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div class="rounded-xl border border-theme-800 overflow-hidden bg-theme-950/45">
              <div class="flex items-center justify-between px-4 py-3 border-b border-theme-800 bg-theme-900/50">
                <div class="text-xs font-medium uppercase tracking-wide text-theme-400">
                  Folders
                </div>
                <button
                  class="p-1.5 text-theme-500 hover:text-theme-200 transition-colors"
                  title="Refresh folders"
                  @click="loadSpaces"
                >
                  <Icon
                    icon="lucide:refresh-cw"
                    class="w-4 h-4"
                    :class="{ 'animate-spin': spacesLoading }"
                  />
                </button>
              </div>
              <div
                v-if="spaces.length === 0"
                class="px-4 py-8 text-center text-sm text-theme-500"
              >
                No memory folder found.
              </div>
              <div
                v-else
                class="py-1"
              >
                <div
                  v-for="space in visibleSpaces"
                  :key="space.id"
                  class="group flex items-center gap-2 px-3 py-2.5 border-b border-theme-900/70 last:border-b-0 transition-colors"
                  :class="[
                    selectedSpaceId === space.id ? 'bg-accent-500/12 text-theme-100' : 'hover:bg-theme-800/35 text-theme-300',
                    dropTargetSpaceId === space.id ? 'ring-1 ring-accent-500/70 ring-inset bg-accent-500/10' : '',
                  ]"
                  :style="{ paddingLeft: `${12 + (space.depth || 0) * 12}px` }"
                  @dragenter.stop="onDragEnter($event, space.id)"
                  @dragleave.stop="onDragLeave($event, space.id)"
                  @dragover.stop="onDragOver($event)"
                  @drop.stop="onFolderDrop($event, space.id)"
                >
                  <button
                    v-if="!space.isDefault"
                    class="p-0.5 text-theme-500 hover:text-theme-200 transition-colors"
                    :class="{ 'invisible': !hasChildren(space) }"
                    @click.stop="toggleFolder(space)"
                  >
                    <Icon
                      icon="lucide:chevron-down"
                      class="w-4 h-4 transition-transform"
                      :class="{ '-rotate-90': isCollapsed(space) }"
                    />
                  </button>
                  <button
                    class="min-w-0 flex flex-1 items-center gap-2 text-left"
                    @click="selectedSpaceId = space.id"
                  >
                    <Icon
                      :icon="space.isDefault ? 'lucide:hard-drive' : isCollapsed(space) ? 'lucide:folder' : 'lucide:folder-open'"
                      class="w-4 h-4 shrink-0"
                      :class="space.isDefault ? 'text-accent-400' : 'text-amber-400'"
                    />
                    <span class="truncate text-sm font-medium">{{ space.name }}</span>
                    <span class="text-xs text-theme-500">{{ space.fileCount }}</span>
                  </button>
                  <button
                    class="p-1 text-theme-600 hover:text-accent-400 opacity-0 group-hover:opacity-100 transition-colors"
                    title="New subfolder"
                    @click.stop="openCreateDialog(space)"
                  >
                    <Icon
                      icon="lucide:plus"
                      class="w-3.5 h-3.5"
                    />
                  </button>
                  <button
                    class="p-1 text-theme-600 hover:text-theme-200 opacity-0 group-hover:opacity-100 transition-colors"
                    title="Rename folder"
                    @click.stop="openEditDialog(space)"
                  >
                    <Icon
                      icon="lucide:pencil"
                      class="w-3.5 h-3.5"
                    />
                  </button>
                  <button
                    :disabled="space.isDefault"
                    class="p-1 text-theme-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-colors disabled:opacity-20 disabled:hover:text-theme-600"
                    title="Archive folder"
                    @click.stop="confirmDeleteSpace(space)"
                  >
                    <Icon
                      icon="lucide:archive"
                      class="w-3.5 h-3.5"
                    />
                  </button>
                </div>
              </div>
            </div>

            <MemoryDocumentList
              v-if="selectedSpaceId"
              ref="docList"
              :space-id="selectedSpaceId"
              :spaces="spaces"
              @edit-space="selectedSpace && openEditDialog(selectedSpace)"
              @delete-space="selectedSpace && confirmDeleteSpace(selectedSpace)"
              @spaces-changed="loadSpaces"
            />
          </div>
        </div>

        <div
          v-else
          class="p-4 sm:p-6 lg:p-8"
        >
          <div class="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div class="grid gap-3 sm:grid-cols-3 lg:min-w-[520px]">
              <div class="rounded-lg border border-theme-800 bg-theme-900/35 px-4 py-3">
                <div class="text-xs text-theme-500">
                  Entities
                </div>
                <div class="mt-1 text-xl font-semibold text-theme-100">
                  {{ graph?.stats.nodeCount ?? 0 }}
                </div>
              </div>
              <div class="rounded-lg border border-theme-800 bg-theme-900/35 px-4 py-3">
                <div class="text-xs text-theme-500">
                  Relations
                </div>
                <div class="mt-1 text-xl font-semibold text-theme-100">
                  {{ graph?.stats.edgeCount ?? 0 }}
                </div>
              </div>
              <div class="rounded-lg border border-theme-800 bg-theme-900/35 px-4 py-3">
                <div class="text-xs text-theme-500">
                  This Week
                </div>
                <div class="mt-1 text-xl font-semibold text-theme-100">
                  {{ graph?.stats.recentEdgeCount ?? 0 }}
                </div>
              </div>
            </div>

            <form
              class="flex items-center gap-2"
              @submit.prevent="loadGraph(graphQuery)"
            >
              <div class="relative">
                <Icon
                  icon="lucide:search"
                  class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-600"
                />
                <input
                  v-model="graphQuery"
                  type="text"
                  class="w-72 max-w-full pl-8 pr-3 py-2 text-sm bg-theme-950 border border-theme-800 rounded-lg text-theme-200 placeholder-theme-600 focus:outline-none focus:border-theme-600"
                  placeholder="Walk from Tom, Acme, Project X"
                >
              </div>
              <button
                class="p-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg transition-colors"
                title="Walk graph"
              >
                <Icon
                  icon="lucide:route"
                  class="w-4 h-4"
                />
              </button>
              <button
                v-if="graphQuery.trim() || graph?.seedNodes.length"
                type="button"
                class="p-2 text-theme-500 hover:text-theme-200 transition-colors"
                title="Show full graph"
                @click="clearGraphWalk"
              >
                <Icon
                  icon="lucide:x"
                  class="w-4 h-4"
                />
              </button>
            </form>
          </div>

          <p
            v-if="activePanel === 'visual'"
            class="mb-4 text-xs text-theme-500"
          >
            Search walks outward from matching entities and refocuses the canvas on that neighborhood.
          </p>

          <div
            v-if="graphLoading && !graph"
            class="flex items-center justify-center gap-2 py-12 text-sm text-theme-500"
          >
            <Icon
              icon="lucide:loader-2"
              class="w-4 h-4 animate-spin"
            />
            Loading graph...
          </div>

          <template v-else-if="graph">
            <div
              v-if="graph.seedNodes.length"
              class="mb-4 flex flex-wrap gap-2"
            >
              <span
                v-for="node in graph.seedNodes"
                :key="node.id"
                class="inline-flex items-center gap-1.5 rounded-md border border-accent-500/30 bg-accent-500/10 px-2 py-1 text-xs text-accent-200"
              >
                <Icon
                  icon="lucide:sparkles"
                  class="w-3 h-3"
                />
                {{ node.name }}
                <span class="text-accent-300/70">{{ node.type }}</span>
              </span>
            </div>

            <div
              v-if="graph.edges.length === 0"
              class="py-12 text-center text-sm text-theme-500"
            >
              No relationships have been extracted yet.
            </div>

            <div
              v-else-if="activePanel === 'visual'"
              class="h-[calc(100vh-255px)] min-h-[560px] rounded-lg border border-theme-800 bg-theme-950 overflow-hidden"
            >
              <VueFlow
                :id="ENTITY_FLOW_ID"
                :nodes="graphFlowNodes"
                :edges="graphFlowEdges"
                fit-view-on-init
                :min-zoom="0.2"
                :max-zoom="1.8"
                class="entity-flow"
              >
                <template #node-entity="{ data, selected }">
                  <NodeToolbar
                    :is-visible="selected"
                    :position="Position.Top"
                    class="entity-node-toolbar"
                  >
                    <button
                      type="button"
                      title="Edit entity"
                      @click.stop="openEditNode(data.entity)"
                    >
                      <Icon
                        icon="lucide:pencil"
                        class="w-3.5 h-3.5"
                      />
                    </button>
                    <button
                      type="button"
                      title="Delete entity"
                      @click.stop="confirmDeleteNode(data.entity)"
                    >
                      <Icon
                        icon="lucide:trash-2"
                        class="w-3.5 h-3.5"
                      />
                    </button>
                  </NodeToolbar>

                  <div class="entity-node-body">
                    <div class="entity-node-label">
                      {{ data.label }}
                    </div>
                    <div class="entity-node-type">
                      {{ data.entity.type }}
                    </div>
                  </div>

                  <Handle
                    v-if="data.connectedHandles.has('target-top')"
                    id="target-top"
                    type="target"
                    :position="Position.Top"
                    class="entity-handle entity-handle-target"
                  />
                  <Handle
                    v-if="data.connectedHandles.has('source-top')"
                    id="source-top"
                    type="source"
                    :position="Position.Top"
                    class="entity-handle entity-handle-source"
                  />
                  <Handle
                    v-if="data.connectedHandles.has('target-right')"
                    id="target-right"
                    type="target"
                    :position="Position.Right"
                    class="entity-handle entity-handle-target"
                  />
                  <Handle
                    v-if="data.connectedHandles.has('source-right')"
                    id="source-right"
                    type="source"
                    :position="Position.Right"
                    class="entity-handle entity-handle-source"
                  />
                  <Handle
                    v-if="data.connectedHandles.has('target-bottom')"
                    id="target-bottom"
                    type="target"
                    :position="Position.Bottom"
                    class="entity-handle entity-handle-target"
                  />
                  <Handle
                    v-if="data.connectedHandles.has('source-bottom')"
                    id="source-bottom"
                    type="source"
                    :position="Position.Bottom"
                    class="entity-handle entity-handle-source"
                  />
                  <Handle
                    v-if="data.connectedHandles.has('target-left')"
                    id="target-left"
                    type="target"
                    :position="Position.Left"
                    class="entity-handle entity-handle-target"
                  />
                  <Handle
                    v-if="data.connectedHandles.has('source-left')"
                    id="source-left"
                    type="source"
                    :position="Position.Left"
                    class="entity-handle entity-handle-source"
                  />
                </template>
              </VueFlow>
            </div>

            <div
              v-else
              class="divide-y divide-theme-900/80 rounded-lg border border-theme-800 overflow-hidden"
            >
              <div
                v-for="edge in graph.edges"
                :key="edge.id"
                class="px-4 py-3 bg-theme-950/35"
              >
                <div class="flex flex-wrap items-center gap-2 text-sm">
                  <span class="font-medium text-theme-100">{{ edge.fromName }}</span>
                  <Icon
                    icon="lucide:arrow-right"
                    class="w-3.5 h-3.5 text-theme-500"
                  />
                  <span class="rounded-md bg-theme-800 px-2 py-0.5 text-xs text-theme-300">{{ formatRelation(edge.relation) }}</span>
                  <Icon
                    icon="lucide:arrow-right"
                    class="w-3.5 h-3.5 text-theme-500"
                  />
                  <span class="font-medium text-theme-100">{{ edge.toName }}</span>
                  <span class="ml-auto text-xs text-theme-600">{{ formatDate(edge.lastSeenAt) }}</span>
                  <button
                    class="p-1 text-theme-600 hover:text-theme-200 transition-colors"
                    title="Edit relationship"
                    @click="openEditEdge(edge)"
                  >
                    <Icon
                      icon="lucide:pencil"
                      class="w-3.5 h-3.5"
                    />
                  </button>
                  <button
                    class="p-1 text-theme-600 hover:text-red-400 transition-colors"
                    title="Delete relationship"
                    @click="confirmDeleteEdge(edge)"
                  >
                    <Icon
                      icon="lucide:trash-2"
                      class="w-3.5 h-3.5"
                    />
                  </button>
                </div>
                <div
                  v-if="edge.evidence"
                  class="mt-2 text-xs text-theme-500 leading-relaxed"
                >
                  {{ edge.evidence }}
                </div>
              </div>
            </div>
          </template>
        </div>
      </main>

      <Teleport to="body">
        <div
          v-if="showCreateDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          @click.self="showCreateDialog = false"
        >
          <div class="bg-theme-900 border border-theme-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 class="text-base font-medium text-theme-200 mb-4">
              {{ editingSpace ? "Edit Folder" : "New Memory Folder" }}
            </h3>
            <div class="space-y-3">
              <div
                v-if="!editingSpace"
                class="text-xs text-theme-500"
              >
                Parent: <span class="text-theme-300">{{ parentForCreate?.name || "Default" }}</span>
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Name</label>
                <input
                  v-model="folderName"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500"
                  placeholder="e.g. Project Notes"
                  @keydown.enter="saveFolder"
                >
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Description (optional)</label>
                <input
                  v-model="folderDescription"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500"
                >
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <button
                class="px-3 py-1.5 text-sm text-theme-400 hover:text-theme-200"
                @click="showCreateDialog = false"
              >
                Cancel
              </button>
              <button
                :disabled="!folderName.trim()"
                class="px-4 py-1.5 bg-accent-600 hover:bg-accent-500 text-white text-sm rounded-lg disabled:opacity-50"
                @click="saveFolder"
              >
                {{ editingSpace ? "Save" : "Create" }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <ModalDialog
        :show="showDeleteConfirm"
        title="Archive Memory Folder"
        icon="lucide:archive"
        icon-color="red"
        @close="showDeleteConfirm = false"
      >
        <p class="text-theme-400 leading-relaxed">
          Archive <strong class="text-theme-200">{{ pendingDeleteSpace?.name }}</strong>? Its folder will be moved to the memory trash and its indexed chunks will be removed.
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="deleteSpace(pendingDeleteSpace!)"
          >
            Archive Folder
          </button>
          <button
            class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
            @click="showDeleteConfirm = false"
          >
            Cancel
          </button>
        </template>
      </ModalDialog>

      <Teleport to="body">
        <div
          v-if="editingNode"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          @click.self="editingNode = null"
        >
          <div class="bg-theme-900 border border-theme-700 rounded-xl p-6 w-full max-w-lg shadow-xl">
            <h3 class="text-base font-medium text-theme-200 mb-4">
              Edit Entity
            </h3>
            <div class="space-y-3">
              <div>
                <label class="block text-xs text-theme-400 mb-1">Name</label>
                <input
                  v-model="nodeName"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500"
                  placeholder="e.g. Acme"
                  @keydown.enter="saveNode"
                >
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Type</label>
                <select
                  v-model="nodeType"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 focus:outline-none focus:border-theme-500"
                >
                  <option
                    v-for="type in ENTITY_NODE_TYPES"
                    :key="type"
                    :value="type"
                  >
                    {{ type }}
                  </option>
                </select>
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Aliases</label>
                <input
                  v-model="nodeAliases"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500"
                  placeholder="Comma-separated aliases"
                  @keydown.enter="saveNode"
                >
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <button
                class="px-3 py-1.5 text-sm text-theme-400 hover:text-theme-200"
                @click="editingNode = null"
              >
                Cancel
              </button>
              <button
                :disabled="!nodeName.trim()"
                class="px-4 py-1.5 bg-accent-600 hover:bg-accent-500 text-white text-sm rounded-lg disabled:opacity-50"
                @click="saveNode"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <Teleport to="body">
        <div
          v-if="editingEdge"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          @click.self="editingEdge = null"
        >
          <div class="bg-theme-900 border border-theme-700 rounded-xl p-6 w-full max-w-lg shadow-xl">
            <h3 class="text-base font-medium text-theme-200 mb-4">
              Edit Relationship
            </h3>
            <div class="space-y-3">
              <div class="text-sm text-theme-400">
                <span class="text-theme-200">{{ editingEdge.fromName }}</span>
                <Icon
                  icon="lucide:arrow-right"
                  class="inline w-3.5 h-3.5 mx-1 text-theme-500"
                />
                <span class="text-theme-200">{{ editingEdge.toName }}</span>
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Relation</label>
                <input
                  v-model="edgeRelation"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500"
                  placeholder="e.g. works_at"
                  @keydown.enter="saveEdge"
                >
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Evidence</label>
                <textarea
                  v-model="edgeEvidence"
                  rows="3"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500 resize-none"
                />
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Confidence: {{ edgeConfidence }}%</label>
                <input
                  v-model.number="edgeConfidence"
                  type="range"
                  min="10"
                  max="100"
                  step="5"
                  class="w-full accent-accent-500"
                >
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <button
                class="px-3 py-1.5 text-sm text-theme-400 hover:text-theme-200"
                @click="editingEdge = null"
              >
                Cancel
              </button>
              <button
                :disabled="!edgeRelation.trim()"
                class="px-4 py-1.5 bg-accent-600 hover:bg-accent-500 text-white text-sm rounded-lg disabled:opacity-50"
                @click="saveEdge"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <ModalDialog
        :show="Boolean(pendingDeleteNode)"
        title="Delete Entity"
        icon="lucide:trash-2"
        icon-color="red"
        @close="pendingDeleteNode = null"
      >
        <p class="text-theme-400 leading-relaxed">
          Delete <strong class="text-theme-200">{{ pendingDeleteNode?.name }}</strong> and all of its relationships?
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="pendingDeleteNode && deleteNode(pendingDeleteNode)"
          >
            Delete Entity
          </button>
          <button
            class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
            @click="pendingDeleteNode = null"
          >
            Cancel
          </button>
        </template>
      </ModalDialog>

      <ModalDialog
        :show="Boolean(pendingDeleteEdge)"
        title="Delete Relationship"
        icon="lucide:trash-2"
        icon-color="red"
        @close="pendingDeleteEdge = null"
      >
        <p class="text-theme-400 leading-relaxed">
          Delete
          <strong class="text-theme-200">{{ pendingDeleteEdge?.fromName }}</strong>
          -> {{ pendingDeleteEdge ? formatRelation(pendingDeleteEdge.relation) : "" }} ->
          <strong class="text-theme-200">{{ pendingDeleteEdge?.toName }}</strong>?
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="pendingDeleteEdge && deleteEdge(pendingDeleteEdge)"
          >
            Delete Relationship
          </button>
          <button
            class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
            @click="pendingDeleteEdge = null"
          >
            Cancel
          </button>
        </template>
      </ModalDialog>
    </div>
  </div>
</template>

<style scoped>
:deep(.entity-flow) {
  background: #030712;
}

:deep(.entity-flow-node) {
  border: 1px solid rgba(139, 92, 246, 0.45);
  background: rgba(17, 24, 39, 0.96);
  color: #f3f4f6;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.22);
}

:deep(.entity-flow-node-seed) {
  border-color: rgba(34, 211, 238, 0.8);
  background: rgba(8, 47, 73, 0.96);
  box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.2), 0 14px 28px rgba(0, 0, 0, 0.28);
}

:deep(.entity-flow-edge path) {
  stroke: #8b5cf6;
}

:deep(.entity-node-body) {
  display: grid;
  min-width: 150px;
  max-width: 250px;
  min-height: 44px;
  place-items: center;
  gap: 2px;
  padding: 8px 12px;
  text-align: center;
}

:deep(.entity-node-label) {
  max-width: 220px;
  overflow-wrap: anywhere;
  line-height: 1.2;
}

:deep(.entity-node-type) {
  color: rgba(165, 180, 252, 0.72);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
}

:deep(.entity-handle) {
  width: 6px;
  height: 6px;
  border: 1px solid rgba(243, 244, 246, 0.85);
  background: #030712;
}

:deep(.entity-handle-source) {
  background: rgba(139, 92, 246, 0.95);
}

:deep(.entity-node-toolbar) {
  display: flex;
  gap: 4px;
  padding: 5px;
  border: 1px solid rgba(139, 92, 246, 0.45);
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.96);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.32);
}

:deep(.entity-node-toolbar button) {
  display: grid;
  width: 28px;
  height: 26px;
  place-items: center;
  border-radius: 6px;
  color: #c4b5fd;
  transition: background-color 120ms ease, color 120ms ease;
}

:deep(.entity-node-toolbar button:hover) {
  background: rgba(139, 92, 246, 0.18);
  color: #f3f4f6;
}

:deep(.entity-flow-edge .vue-flow__edge-textbg) {
  stroke: rgba(139, 92, 246, 0.35);
  stroke-width: 1px;
}
</style>
