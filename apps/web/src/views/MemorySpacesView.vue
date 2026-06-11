<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { MarkerType, useVueFlow, type Edge, type Node } from "@vue-flow/core";
import { Icon } from "@iconify/vue";
import { useLocalStorage } from "@vueuse/core";
import { api } from "../api/client";
import type { EntityGraphEdge, EntityGraphNode, EntityGraphNodeType, EntityGraphResponse, MemorySpace } from "../api/types";
import ModalDialog from "../components/shared/ModalDialog.vue";
import MemoryDocumentsSection from "../components/memory/MemoryDocumentsSection.vue";
import MemoryRelationshipsSection from "../components/memory/MemoryRelationshipsSection.vue";
import MemoryVisualGraphSection from "../components/memory/MemoryVisualGraphSection.vue";
import type { FlowEdgeData, FlowNodeData } from "../components/memory/memory-graph-types";
import { syncPrefsToElectron } from "../utils/electron-prefs";
import { SK_MEMORY_GRAPH_EDGE_LABELS, SK_MEMORY_GRAPH_NODE_SPACING } from "../utils/storage-keys";

const ENTITY_FLOW_ID = "memory-entity-graph";
const VISUAL_GRAPH_LIMIT = 200;
const RELATIONSHIPS_GRAPH_LIMIT = 5000;

type MemoryPanel = "documents" | "relationships" | "visual";
type GraphViewMode = "relationships" | "visual";
type FlowPoint = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const ENTITY_NODE_TYPES: EntityGraphNodeType[] = [
  "person",
  "place",
  "organization",
  "project",
  "event",
  "date",
  "technology",
  "product",
  "artifact",
  "concept",
  "other",
];

const memorySections = [
  {
    id: "documents",
    path: "/memory-spaces/documents",
    label: "Documents",
    description: "Browse folders, upload files, and manage indexed memory documents.",
    icon: "lucide:file-text",
  },
  {
    id: "relationships",
    path: "/memory-spaces/relationships",
    label: "Relationships",
    description: "Inspect, correct, and delete extracted entity connections.",
    icon: "lucide:git-branch",
  },
  {
    id: "visual",
    path: "/memory-spaces/visual-graph",
    label: "Visual Graph",
    description: "Explore entities as a spatial graph with more room to breathe.",
    icon: "lucide:network",
  },
] as const;

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
const activePanel = ref<MemoryPanel>("documents");

const graph = ref<EntityGraphResponse | null>(null);
const graphLoading = ref(false);
const graphQuery = ref("");
const graphSuggestions = ref<EntityGraphNode[]>([]);
const graphLimit = ref<number | null>(null);
const graphView = ref<GraphViewMode | null>(null);
const editingNode = ref<EntityGraphNode | null>(null);
const editingEdge = ref<EntityGraphEdge | null>(null);
const pendingDeleteNode = ref<EntityGraphNode | null>(null);
const pendingDeleteNodes = ref<EntityGraphNode[]>([]);
const pendingDeleteEdge = ref<EntityGraphEdge | null>(null);
const nodeName = ref("");
const nodeType = ref<EntityGraphNodeType>("other");
const nodeAliases = ref("");
const edgeRelation = ref("");
const edgeEvidence = ref("");
const edgeConfidence = ref(70);
const graphFlowNodes = ref<Node<FlowNodeData>[]>([]);
const graphFlowEdges = ref<Edge<FlowEdgeData>[]>([]);
const nodeSpacing = useLocalStorage(SK_MEMORY_GRAPH_NODE_SPACING, 1.0);
const showGraphEdgeLabels = useLocalStorage(SK_MEMORY_GRAPH_EDGE_LABELS, true);

const route = useRoute();
const { fitView } = useVueFlow(ENTITY_FLOW_ID);
let elkPromise: Promise<InstanceType<typeof import("elkjs/lib/elk-api").default>> | null = null;
let graphSuggestionTimer: number | null = null;
let graphSuggestionRequest = 0;
let graphRequest = 0;
let graphLayoutRequest = 0;
let fitGraphAfterLayout = false;
let inFlightGraphKey = "";

const panelByRouteSegment: Record<string, MemoryPanel> = {
  documents: "documents",
  relationships: "relationships",
  "visual-graph": "visual",
};

const activeSection = computed(() =>
  memorySections.find((section) => section.id === activePanel.value) || memorySections[0],
);

const activeGraphView = computed<GraphViewMode | null>(() => {
  if (activePanel.value === "relationships") return "relationships";
  if (activePanel.value === "visual") return "visual";
  return null;
});

const activeGraph = computed(() =>
  activeGraphView.value && graphView.value === activeGraphView.value ? graph.value : null,
);

const selectedSpace = computed(() =>
  spaces.value.find((s) => s.id === selectedSpaceId.value) || null,
);

async function getElk() {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk-api").then(({ default: ELK }) => new ELK({
      workerUrl: "/elk-worker.min.js",
    }));
  }
  return elkPromise;
}

async function layoutGraph() {
  const requestId = ++graphLayoutRequest;
  const currentGraph = activePanel.value === "visual" ? activeGraph.value : null;
  if (!currentGraph) {
    graphFlowNodes.value = [];
    graphFlowEdges.value = [];
    return;
  }

  const nodeLabels = new Map<string, EntityGraphNode>();
  for (const node of currentGraph.nodes) nodeLabels.set(node.id, node);
  for (const edge of currentGraph.edges) {
    if (!nodeLabels.has(edge.fromNodeId)) nodeLabels.set(edge.fromNodeId, fallbackGraphNode(edge.fromNodeId, edge.fromName));
    if (!nodeLabels.has(edge.toNodeId)) nodeLabels.set(edge.toNodeId, fallbackGraphNode(edge.toNodeId, edge.toName));
  }

  const seedIds = new Set(currentGraph.seedNodes.map((node) => node.id));
  const dimensions = new Map<string, { width: number; height: number }>(
    [...nodeLabels.entries()].map(([id, node]) => [id, nodeDimensions(node.name, node.importance)]),
  );

  const elk = await getElk();
  const layout = await elk.layout({
    id: "entity-root",
    layoutOptions: {
      "elk.algorithm": "stress",
      "elk.stress.desiredEdgeLength": String(Math.round(280 * nodeSpacing.value)),
      "elk.spacing.nodeNode": String(Math.round(120 * nodeSpacing.value)),
      "elk.separateConnectedComponents": "true",
      "elk.disco.componentCompaction.strategy": "POLYOMINO",
      "elk.randomSeed": "7",
    },
    children: [...nodeLabels.keys()].map((id) => ({
      id,
      width: dimensions.get(id)?.width || 150,
      height: dimensions.get(id)?.height || 44,
    })),
    edges: currentGraph.edges.map((edge) => ({
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

  const edgeGroups = new Map<string, EntityGraphEdge[]>();
  for (const edge of currentGraph.edges) {
    const key = edgePairKey(edge.fromNodeId, edge.toNodeId);
    if (!edgeGroups.has(key)) edgeGroups.set(key, []);
    edgeGroups.get(key)!.push(edge);
  }

  const connectedHandles = new Map<string, Set<string>>();
  const edges: Edge<FlowEdgeData>[] = Array.from(edgeGroups.values()).map((group) => {
    const edge = group[0];
    const labelGroups = groupedEdgeLabels(group);
    const isBidirectional = labelGroups.length > 1;
    const handles = closestHandles(points.get(edge.fromNodeId), points.get(edge.toNodeId));
    if (!connectedHandles.has(edge.fromNodeId)) connectedHandles.set(edge.fromNodeId, new Set());
    if (!connectedHandles.has(edge.toNodeId)) connectedHandles.set(edge.toNodeId, new Set());
    connectedHandles.get(edge.fromNodeId)!.add(handles.sourceHandle);
    connectedHandles.get(edge.toNodeId)!.add(handles.targetHandle);
    return {
      id: group.map((item) => item.id).join("__"),
      type: "stacked",
      source: edge.fromNodeId,
      target: edge.toNodeId,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      markerEnd: MarkerType.ArrowClosed,
      markerStart: isBidirectional ? MarkerType.ArrowClosed : undefined,
      class: "entity-flow-edge",
      data: {
        labels: labelGroups.flatMap((item) => item.labels),
        labelGroups,
        isBidirectional,
      },
      style: { stroke: "var(--memory-flow-edge)", strokeWidth: 1.8 },
    };
  });

  const nodes: Node<FlowNodeData>[] = [];
  for (const [id, entity] of nodeLabels.entries()) {
    nodes.push({
      id,
      type: "entity",
      position: positions.get(id) || { x: 0, y: 0 },
      class: [
        "entity-flow-node",
        entityTypeClass(entity.type),
        seedIds.has(id) ? "entity-flow-node-seed" : "",
      ].filter(Boolean).join(" "),
      data: { entity, label: entity.name, isSeed: seedIds.has(id), connectedHandles: connectedHandles.get(id) ?? new Set() },
    });
  }
  if (requestId !== graphLayoutRequest) return;
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
    importance: 1,
    mentionCount: 0,
    sourceCount: 0,
    firstSeenAt: 0,
    lastSeenAt: 0,
  };
}

function nodeDimensions(label: string, importance: number = 1): { width: number; height: number } {
  const baseHeight = label.length > 18 ? 56 : 44;
  const importanceScale = 1 + (importance * 0.1);
  return {
    width: Math.max(150, Math.min(250, label.length * 8 + 54)) * importanceScale,
    height: baseHeight * importanceScale,
  };
}

function edgePairKey(fromNodeId: string, toNodeId: string): string {
  return [fromNodeId, toNodeId].sort().join("<->");
}

function groupedEdgeLabels(edges: EntityGraphEdge[]): FlowEdgeData["labelGroups"] {
  const groups = new Map<string, FlowEdgeData["labelGroups"][number]>();
  for (const edge of edges) {
    const key = `${edge.fromNodeId}->${edge.toNodeId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        fromName: edge.fromName,
        toName: edge.toName,
        labels: [],
      });
    }
    groups.get(key)!.labels.push(formatRelation(edge.relation));
  }
  return [...groups.values()];
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

watch([activeGraph, () => activePanel.value], async () => {
  await layoutGraph();
  if (!fitGraphAfterLayout || activePanel.value !== "visual" || graphFlowNodes.value.length === 0) return;
  fitGraphAfterLayout = false;
  await nextTick();
  window.setTimeout(() => {
    fitView({ padding: 0.18, duration: 320 }).catch(() => undefined);
  }, 40);
});

watch([nodeSpacing, showGraphEdgeLabels], () => {
  syncPrefsToElectron();
});

async function relayout() {
  await layoutGraph();
  if (graphFlowNodes.value.length === 0) return;
  await nextTick();
  window.setTimeout(() => {
    fitView({ padding: 0.18, duration: 320 }).catch(() => undefined);
  }, 40);
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

function formatRelation(relation: string): string {
  return relation.replace(/_/g, " ");
}

function entityTypeClass(type: EntityGraphNodeType): string {
  return `entity-flow-node-type-${type}`;
}

async function loadGraph(query = graphQuery.value) {
  const trimmedQuery = query.trim();
  const limit = activePanel.value === "relationships" ? RELATIONSHIPS_GRAPH_LIMIT : VISUAL_GRAPH_LIMIT;
  const view = activeGraphView.value || "visual";
  const requestKey = `${view}:${trimmedQuery}:${limit}`;
  if (graphLoading.value && inFlightGraphKey === requestKey) return;
  const requestId = ++graphRequest;
  inFlightGraphKey = requestKey;
  graphLoading.value = true;
  graphSuggestions.value = [];
  try {
    const nextGraph = await api.memory.getGraph(trimmedQuery || undefined, limit, view);
    if (requestId !== graphRequest) return;
    graph.value = nextGraph;
    graphLimit.value = limit;
    graphView.value = view;
  } catch {
    if (requestId !== graphRequest) return;
    graph.value = null;
    graphLimit.value = null;
    graphView.value = null;
  } finally {
    if (requestId === graphRequest) {
      graphLoading.value = false;
      inFlightGraphKey = "";
    }
  }
}

async function clearGraphWalk() {
  graphQuery.value = "";
  graphSuggestions.value = [];
  await loadGraph("");
}

async function loadGraphSuggestions(query = graphQuery.value) {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    graphSuggestions.value = [];
    return;
  }

  const requestId = ++graphSuggestionRequest;
  try {
    const result = await api.memory.getGraphSuggestions(trimmed, 8);
    if (requestId !== graphSuggestionRequest) return;
    graphSuggestions.value = result.suggestions.filter((node) => node.name.toLowerCase() !== trimmed.toLowerCase());
  } catch {
    if (requestId === graphSuggestionRequest) graphSuggestions.value = [];
  }
}

async function selectGraphSuggestion(node: EntityGraphNode) {
  graphQuery.value = node.name;
  graphSuggestions.value = [];
  await loadGraph(node.name);
}

watch(graphQuery, (query) => {
  if (graphSuggestionTimer) window.clearTimeout(graphSuggestionTimer);
  graphSuggestionTimer = window.setTimeout(() => {
    loadGraphSuggestions(query);
  }, 140);
});

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

function confirmDeleteNodes(nodes: EntityGraphNode[]) {
  pendingDeleteNodes.value = nodes;
}

async function deleteNode(node: EntityGraphNode) {
  pendingDeleteNode.value = null;
  await api.memory.deleteGraphNode(node.id);
  await loadGraph();
}

async function deleteNodes(nodes: EntityGraphNode[]) {
  pendingDeleteNodes.value = [];
  await Promise.all(nodes.map(node => api.memory.deleteGraphNode(node.id)));
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

async function deleteEdges(ids: string[]) {
  await Promise.all(ids.map(id => api.memory.deleteGraphEdge(id)));
  await loadGraph();
}

watch(
  () => route.params.section,
  async (sectionParam) => {
    const section = Array.isArray(sectionParam) ? sectionParam[0] : sectionParam;
    const panel = panelByRouteSegment[section || "documents"] || "documents";
    const enteringVisual = panel === "visual" && activePanel.value !== "visual";
    activePanel.value = panel;
    if (enteringVisual) fitGraphAfterLayout = true;
    const expectedGraphLimit = panel === "relationships" ? RELATIONSHIPS_GRAPH_LIMIT : VISUAL_GRAPH_LIMIT;
    const expectedGraphView: GraphViewMode = panel === "relationships" ? "relationships" : "visual";
    if ((panel === "relationships" || panel === "visual") && (!graph.value || graphLimit.value !== expectedGraphLimit || graphView.value !== expectedGraphView)) await loadGraph();
  },
  { immediate: true },
);

onMounted(() => loadSpaces());
</script>

<template>
  <div class="h-full overflow-y-auto relative">
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
          <RouterLink
            v-for="section in memorySections"
            :key="section.id"
            :to="section.path"
            class="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-all lg:w-full"
            :class="activePanel === section.id ? 'bg-theme-800 text-theme-100 shadow-[inset_3px_0_0_var(--color-accent-500,#3b82f6)]' : 'text-theme-400 hover:bg-theme-800/70 hover:text-theme-200'"
          >
            <Icon
              :icon="section.icon"
              class="h-4.5 w-4.5 shrink-0"
            />
            <span class="whitespace-nowrap">{{ section.label }}</span>
          </RouterLink>
        </nav>
      </aside>

      <main class="min-w-0 flex-1 overflow-y-auto flex-col flex h-full">
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

        <MemoryDocumentsSection
          v-else-if="activePanel === 'documents'"
          v-model:selected-space-id="selectedSpaceId"
          :spaces="spaces"
          :spaces-loading="spacesLoading"
          :selected-space="selectedSpace"
          @create-folder="openCreateDialog"
          @edit-folder="openEditDialog"
          @delete-folder="confirmDeleteSpace"
          @refresh-spaces="loadSpaces"
        />

        <MemoryRelationshipsSection
          v-else-if="activePanel === 'relationships'"
          v-model:graph-query="graphQuery"
          :graph="activeGraph"
          :graph-loading="graphLoading"
          :graph-suggestions="graphSuggestions"
          @load-graph="loadGraph"
          @clear-walk="clearGraphWalk"
          @select-suggestion="selectGraphSuggestion"
          @edit-edge="openEditEdge"
          @delete-edge="confirmDeleteEdge"
          @delete-edges="deleteEdges"
        />

        <MemoryVisualGraphSection
          v-else
          v-model:graph-query="graphQuery"
          v-model:node-spacing="nodeSpacing"
          v-model:edge-labels-visible="showGraphEdgeLabels"
          :flow-id="ENTITY_FLOW_ID"
          :graph="activeGraph"
          :graph-loading="graphLoading"
          :graph-flow-nodes="graphFlowNodes"
          :graph-flow-edges="graphFlowEdges"
          :graph-suggestions="graphSuggestions"
          @load-graph="loadGraph"
          @clear-walk="clearGraphWalk"
          @select-suggestion="selectGraphSuggestion"
          @relayout="relayout"
          @edit-node="openEditNode"
          @delete-node="confirmDeleteNode"
          @delete-nodes="confirmDeleteNodes"
        />
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
        :show="pendingDeleteNodes.length > 0"
        title="Delete Entities"
        icon="lucide:trash-2"
        icon-color="red"
        @close="pendingDeleteNodes = []"
      >
        <p class="text-theme-400 leading-relaxed">
          Delete <strong class="text-theme-200">{{ pendingDeleteNodes.length }}</strong> selected entities and all of their relationships?
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="pendingDeleteNodes.length && deleteNodes(pendingDeleteNodes)"
          >
            Delete Entities
          </button>
          <button
            class="w-full px-4 py-3 bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-xl text-center font-medium transition-colors"
            @click="pendingDeleteNodes = []"
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
          -&gt; {{ pendingDeleteEdge ? formatRelation(pendingDeleteEdge.relation) : "" }} -&gt;
          <strong class="text-theme-200">{{ pendingDeleteEdge?.toName }}</strong>? Any entities left without relationships will also be deleted.
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
