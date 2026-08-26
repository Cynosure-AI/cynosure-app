<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Icon } from "@iconify/vue";
import { useLocalStorage } from "@vueuse/core";
import { api } from "../api/client";
import type { KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraphNodeType, KnowledgeGraph, MemorySpace } from "../api/types";
import ModalDialog from "../components/shared/ModalDialog.vue";
import MultiSelect, { type MultiSelectOption } from "../components/shared/MultiSelect.vue";
import TabBar, { type TabDef } from "../components/shared/TabBar.vue";
import MemoryDocumentsSection from "../components/memory/MemoryDocumentsSection.vue";
import KnowledgeFactsSection from "../components/memory/KnowledgeFactsSection.vue";
import KnowledgeGraphSection from "../components/memory/KnowledgeGraphSection.vue";
import type { GraphEdgePathType } from "../components/memory/knowledge-graph-types";
import { syncPrefsToElectron } from "../utils/electron-prefs";
import { selectConnectedGraph } from "../utils/knowledge-graph-selection";
import { KNOWLEDGE_GRAPH_FLOW_ID as KNOWLEDGE_FLOW_ID, useKnowledgeGraphLayout } from "../composables/useKnowledgeGraphLayout";
import { SK_KNOWLEDGE_GRAPH_EDGE_LABELS, SK_KNOWLEDGE_GRAPH_EDGE_PATH_TYPE, SK_KNOWLEDGE_GRAPH_NODE_SPACING } from "../utils/storage-keys";

const VISUAL_GRAPH_RELATION_LIMIT = 500;
const ALL_GRAPH_LIMIT = 5000;
const RELATIONSHIPS_GRAPH_LIMIT = 5000;

type MemoryPanel = "documents" | "relationships" | "visual";
type GraphViewMode = "relationships" | "visual";
type FactLevelFilter = 0 | 1 | 2 | 3;
type GraphEntityLimit = 100 | 200 | 300 | 500 | null;

const ENTITY_NODE_TYPES: KnowledgeGraphNodeType[] = [
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
    label: "Knowledge",
    description: "Inspect, correct, and manage facts extracted from memory.",
    icon: "lucide:git-branch",
  },
  {
    id: "visual",
    path: "/memory-spaces/visual-graph",
    label: "Knowledge Graph",
    description: "Explore extracted knowledge as a spatial graph with more room to breathe.",
    icon: "lucide:network",
  },
] as const;

const memoryTabs: TabDef<MemoryPanel>[] = memorySections.map((section) => ({
  value: section.id,
  label: section.label,
  icon: section.icon,
}));

const spaces = ref<MemorySpace[]>([]);
const spacesLoading = ref(false);
const selectedSpaceId = ref<string | null>(null);
const graphSelectedSpaceIds = ref<string[]>([]);
const graphSpaceSelectionInitialized = ref(false);
const showCreateDialog = ref(false);
const editingSpace = ref<MemorySpace | null>(null);
const parentForCreate = ref<MemorySpace | null>(null);
const folderName = ref("");
const folderDescription = ref("");
const showDeleteConfirm = ref(false);
const pendingDeleteSpace = ref<MemorySpace | null>(null);
const activePanel = ref<MemoryPanel>("documents");

const graph = ref<KnowledgeGraph | null>(null);
const graphLoading = ref(false);
const graphQuery = ref("");
const graphSearchQuery = ref("");
const graphSuggestions = ref<KnowledgeGraphNode[]>([]);
const graphSelectedNodes = ref<KnowledgeGraphNode[]>([]);
const graphLimit = ref<number | null>(null);
const graphView = ref<GraphViewMode | null>(null);
const graphFactLevel = ref<FactLevelFilter>(0);
const graphEntityLimit = ref<GraphEntityLimit>(100);
const editingNode = ref<KnowledgeGraphNode | null>(null);
const editingEdge = ref<KnowledgeGraphEdge | null>(null);
const pendingDeleteNode = ref<KnowledgeGraphNode | null>(null);
const pendingDeleteNodes = ref<KnowledgeGraphNode[]>([]);
const pendingDeleteEdge = ref<KnowledgeGraphEdge | null>(null);
const nodeName = ref("");
const nodeType = ref<KnowledgeGraphNodeType>("other");
const nodeAliases = ref("");
const edgeRelation = ref("");
const edgeNote = ref("");
const graphOperationError = ref("");
const graphMutationPending = ref(false);
const nodeSpacing = useLocalStorage(SK_KNOWLEDGE_GRAPH_NODE_SPACING, 1.0);
const showGraphEdgeLabels = useLocalStorage(SK_KNOWLEDGE_GRAPH_EDGE_LABELS, true);
const graphEdgePathType = useLocalStorage<GraphEdgePathType>(SK_KNOWLEDGE_GRAPH_EDGE_PATH_TYPE, "bezier");

const route = useRoute();
const router = useRouter();
let graphSuggestionTimer: number | null = null;
let graphSuggestionRequest = 0;
let graphRequest = 0;
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
const graphSpaceOptions = computed<MultiSelectOption[]>(() => spaces.value.map((space) => ({
  value: space.id,
  label: space.name,
})));

const visualGraph = computed(() => activePanel.value === "visual" ? activeGraph.value : null);
const {
  flowNodes: graphFlowNodes,
  flowEdges: graphFlowEdges,
  focusedNodeId: focusedGraphNodeId,
  fit: relayout,
  requestFit: requestGraphFit,
  setFocusedNode: setFocusedGraphNode,
} = useKnowledgeGraphLayout({
  graph: visualGraph,
  nodeSpacing,
  formatRelation,
});

watch([nodeSpacing, showGraphEdgeLabels, graphEdgePathType], () => {
  syncPrefsToElectron();
});

async function loadSpaces() {
  spacesLoading.value = true;
  try {
    const previousSpaceIds = spaces.value.map((space) => space.id);
    const previouslySelectedAll = !graphSpaceSelectionInitialized.value
      || (previousSpaceIds.length > 0 && previousSpaceIds.every((id) => graphSelectedSpaceIds.value.includes(id)));
    const loaded = await api.memorySpaces.list();
    spaces.value = [...loaded].sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return (a.relativePath || "").localeCompare(b.relativePath || "");
    });
    graphSelectedSpaceIds.value = previouslySelectedAll
      ? spaces.value.map((space) => space.id)
      : graphSelectedSpaceIds.value.filter((id) => spaces.value.some((space) => space.id === id));
    graphSpaceSelectionInitialized.value = true;
    if (!selectedSpaceId.value && spaces.value.length > 0) selectedSpaceId.value = spaces.value[0].id;
    if (selectedSpaceId.value && !spaces.value.some((s) => s.id === selectedSpaceId.value)) {
      selectedSpaceId.value = spaces.value[0]?.id || null;
    }
    if (activeGraphView.value) await loadGraph();
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


function capVisualGraph(nextGraph: KnowledgeGraph, view: GraphViewMode): KnowledgeGraph {
  const entityLimit = graphEntityLimit.value;
  if (view !== "visual" || entityLimit === null || nextGraph.nodes.length <= entityLimit) return nextGraph;
  return selectConnectedGraph(nextGraph, entityLimit);
}

async function loadGraph(
  query = graphQuery.value,
  nodeIds = graphSelectedNodes.value.map((node) => node.id),
  spaceIds = graphSelectedSpaceIds.value,
) {
  const trimmedQuery = query.trim();
  const limit = activePanel.value === "relationships"
    ? RELATIONSHIPS_GRAPH_LIMIT
    : graphEntityLimit.value === null
      ? ALL_GRAPH_LIMIT
      : Math.max(VISUAL_GRAPH_RELATION_LIMIT, graphEntityLimit.value);
  const view = activeGraphView.value || "visual";
  const minImportance = view === "visual" ? graphFactLevel.value : null;
  const requestKey = `${view}:${trimmedQuery}:${[...nodeIds].sort().join(",")}:${[...spaceIds].sort().join(",")}:${limit}:${minImportance ?? "all"}`;
  if (graphLoading.value && inFlightGraphKey === requestKey) return;
  const requestId = ++graphRequest;
  inFlightGraphKey = requestKey;
  graphLoading.value = true;
  graphSuggestions.value = [];
  try {
    const nextGraph = await api.memory.getGraph(
      trimmedQuery || undefined,
      limit,
      view,
      nodeIds,
      minImportance,
      graphSpaceSelectionInitialized.value ? spaceIds : undefined,
    );
    if (requestId !== graphRequest) return;
    focusedGraphNodeId.value = null;
    graph.value = capVisualGraph(nextGraph, view);
    graphSearchQuery.value = trimmedQuery;
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

async function updateGraphSpaceSelection(spaceIds: string[]) {
  graphSelectedSpaceIds.value = spaceIds;
  graphSelectedNodes.value = [];
  await loadGraph(graphQuery.value, [], spaceIds);
}

async function clearGraphWalk() {
  graphQuery.value = "";
  graphSearchQuery.value = "";
  graphSuggestions.value = [];
  graphSelectedNodes.value = [];
  await loadGraph("", []);
}

async function submitGraphSearch(query = graphQuery.value) {
  const trimmedQuery = query.trim();
  if (trimmedQuery) graphSelectedNodes.value = [];
  await loadGraph(trimmedQuery, trimmedQuery ? [] : graphSelectedNodes.value.map((node) => node.id));
}

async function loadGraphSuggestions(query = graphQuery.value) {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    graphSuggestions.value = [];
    return;
  }

  const requestId = ++graphSuggestionRequest;
  try {
    const result = await api.memory.getGraphSuggestions(
      trimmed,
      8,
      graphSpaceSelectionInitialized.value ? graphSelectedSpaceIds.value : undefined,
    );
    if (requestId !== graphSuggestionRequest) return;
    graphSuggestions.value = result.suggestions;
  } catch {
    if (requestId === graphSuggestionRequest) graphSuggestions.value = [];
  }
}

async function selectGraphSuggestion(node: KnowledgeGraphNode) {
  if (!graphSelectedNodes.value.some((selected) => selected.id === node.id)) {
    graphSelectedNodes.value = [...graphSelectedNodes.value, node];
  }
  graphQuery.value = "";
  graphSuggestions.value = [];
  await loadGraph("", graphSelectedNodes.value.map((selected) => selected.id));
}

async function removeSelectedGraphNode(nodeId: string) {
  graphSelectedNodes.value = graphSelectedNodes.value.filter((node) => node.id !== nodeId);
  await loadGraph("", graphSelectedNodes.value.map((node) => node.id));
}

watch(graphQuery, (query) => {
  if (graphSuggestionTimer) window.clearTimeout(graphSuggestionTimer);
  graphSuggestionTimer = window.setTimeout(() => {
    loadGraphSuggestions(query);
  }, 140);
});

function openEditNode(node: KnowledgeGraphNode) {
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

function confirmDeleteNode(node: KnowledgeGraphNode) {
  pendingDeleteNode.value = node;
}

function confirmDeleteNodes(nodes: KnowledgeGraphNode[]) {
  pendingDeleteNodes.value = nodes;
}

async function deleteNode(node: KnowledgeGraphNode) {
  graphOperationError.value = "";
  graphMutationPending.value = true;
  try {
    await api.memory.deleteGraphNode(node.id);
    pendingDeleteNode.value = null;
    graphSelectedNodes.value = graphSelectedNodes.value.filter((selected) => selected.id !== node.id);
    await loadGraph();
  } catch (error) {
    graphOperationError.value = error instanceof Error ? error.message : "Could not delete the entity.";
  } finally {
    graphMutationPending.value = false;
  }
}

async function deleteNodes(nodes: KnowledgeGraphNode[]) {
  graphOperationError.value = "";
  graphMutationPending.value = true;
  try {
    const deletedIds = new Set(nodes.map((node) => node.id));
    await api.memory.deleteGraphNodes([...deletedIds]);
    pendingDeleteNodes.value = [];
    graphSelectedNodes.value = graphSelectedNodes.value.filter((selected) => !deletedIds.has(selected.id));
    await loadGraph();
  } catch (error) {
    graphOperationError.value = error instanceof Error ? error.message : "Could not delete the selected entities.";
  } finally {
    graphMutationPending.value = false;
  }
}

function openEditEdge(edge: KnowledgeGraphEdge) {
  editingEdge.value = edge;
  edgeRelation.value = edge.relation;
  edgeNote.value = edge.note || "";
}

async function saveEdge() {
  if (!editingEdge.value || !edgeRelation.value.trim()) return;
  await api.memory.updateGraphEdge(editingEdge.value.id, {
    relation: edgeRelation.value.trim(),
    note: edgeNote.value,
  });
  editingEdge.value = null;
  await loadGraph();
}

function confirmDeleteEdge(edge: KnowledgeGraphEdge) {
  pendingDeleteEdge.value = edge;
}

async function deleteEdge(edge: KnowledgeGraphEdge) {
  graphOperationError.value = "";
  graphMutationPending.value = true;
  try {
    await api.memory.deleteGraphEdge(edge.id);
    pendingDeleteEdge.value = null;
    await loadGraph();
  } catch (error) {
    graphOperationError.value = error instanceof Error ? error.message : "Could not delete the relationship.";
  } finally {
    graphMutationPending.value = false;
  }
}

async function deleteEdges(ids: string[]) {
  graphOperationError.value = "";
  graphMutationPending.value = true;
  try {
    await api.memory.deleteGraphEdges(ids);
    await loadGraph();
  } catch (error) {
    graphOperationError.value = error instanceof Error ? error.message : "Could not delete the selected relationships.";
  } finally {
    graphMutationPending.value = false;
  }
}

function selectPanel(panel: MemoryPanel) {
  const section = memorySections.find((candidate) => candidate.id === panel);
  if (section && route.path !== section.path) void router.push(section.path);
}

watch(
  () => route.params.section,
  async (sectionParam) => {
    const section = Array.isArray(sectionParam) ? sectionParam[0] : sectionParam;
    const panel = panelByRouteSegment[section || "documents"] || "documents";
    const enteringVisual = panel === "visual" && activePanel.value !== "visual";
    activePanel.value = panel;
    if (enteringVisual) requestGraphFit();
    const expectedGraphLimit = panel === "relationships"
      ? RELATIONSHIPS_GRAPH_LIMIT
      : graphEntityLimit.value === null
        ? ALL_GRAPH_LIMIT
        : Math.max(VISUAL_GRAPH_RELATION_LIMIT, graphEntityLimit.value);
    const expectedGraphView: GraphViewMode = panel === "relationships" ? "relationships" : "visual";
    if ((panel === "relationships" || panel === "visual") && (!graph.value || graphLimit.value !== expectedGraphLimit || graphView.value !== expectedGraphView)) await loadGraph();
  },
  { immediate: true },
);

onMounted(() => loadSpaces());
</script>

<template>
  <div class="relative h-full min-w-0 overflow-y-auto">
    <div class="min-h-full min-w-0">
      <main class="flex min-h-full min-w-0 flex-col">
        <header class="sticky top-0 z-10 border-b border-theme-800/60 bg-theme-950/95 px-4 pt-4 backdrop-blur-sm sm:px-6 sm:pt-5 lg:px-8">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <h1 class="text-2xl font-bold text-theme-100">
                Memory
              </h1>
              <p class="mt-1 text-sm leading-relaxed text-theme-500">
                {{ activeSection.description }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2 self-start">
              <MultiSelect
                v-if="activePanel === 'relationships' || activePanel === 'visual'"
                :model-value="graphSelectedSpaceIds"
                :options="graphSpaceOptions"
                placeholder="No memory folders"
                all-selected-label="All memory folders"
                show-bulk-actions
                class="min-w-64"
                @update:model-value="updateGraphSpaceSelection"
              />
              <button
                v-if="activePanel === 'documents'"
                class="flex items-center gap-2 rounded-lg bg-accent-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-500"
                @click="openCreateDialog()"
              >
                <Icon
                  icon="lucide:folder-plus"
                  class="h-4 w-4"
                />
                New Folder
              </button>
              <button
                v-if="activePanel === 'relationships' || activePanel === 'visual'"
                class="p-2 text-theme-500 transition-colors hover:text-theme-200"
                title="Refresh knowledge graph"
                @click="loadGraph()"
              >
                <Icon
                  icon="lucide:refresh-cw"
                  class="h-4 w-4"
                  :class="{ 'animate-spin': graphLoading }"
                />
              </button>
            </div>
          </div>

          <TabBar
            :model-value="activePanel"
            :tabs="memoryTabs"
            class="mt-4"
            @update:model-value="selectPanel"
          />
        </header>

        <div
          v-if="graphOperationError && (activePanel === 'relationships' || activePanel === 'visual')"
          class="mx-4 mt-4 flex items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 sm:mx-6 lg:mx-8"
          role="alert"
        >
          <span>{{ graphOperationError }}</span>
          <button
            class="shrink-0 text-red-400 transition-colors hover:text-red-200"
            title="Dismiss"
            @click="graphOperationError = ''"
          >
            <Icon
              icon="lucide:x"
              class="h-4 w-4"
            />
          </button>
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

        <KnowledgeFactsSection
          v-else-if="activePanel === 'relationships'"
          v-model:graph-query="graphQuery"
          :graph="activeGraph"
          :graph-loading="graphLoading"
          :graph-suggestions="graphSuggestions"
          :walk-nodes="graphSelectedNodes"
          @load-graph="submitGraphSearch"
          @clear-walk="clearGraphWalk"
          @select-suggestion="selectGraphSuggestion"
          @remove-selected-node="removeSelectedGraphNode"
          @edit-edge="openEditEdge"
          @delete-edge="confirmDeleteEdge"
          @delete-edges="deleteEdges"
        />

        <KnowledgeGraphSection
          v-else
          v-model:graph-query="graphQuery"
          v-model:node-spacing="nodeSpacing"
          v-model:edge-labels-visible="showGraphEdgeLabels"
          v-model:edge-path-type="graphEdgePathType"
          v-model:fact-level="graphFactLevel"
          v-model:entity-limit="graphEntityLimit"
          :flow-id="KNOWLEDGE_FLOW_ID"
          :graph-search-query="graphSearchQuery"
          :graph="activeGraph"
          :graph-loading="graphLoading"
          :graph-flow-nodes="graphFlowNodes"
          :graph-flow-edges="graphFlowEdges"
          :graph-suggestions="graphSuggestions"
          :walk-nodes="graphSelectedNodes"
          @load-graph="submitGraphSearch"
          @clear-walk="clearGraphWalk"
          @select-suggestion="selectGraphSuggestion"
          @explore-node="selectGraphSuggestion"
          @remove-selected-node="removeSelectedGraphNode"
          @relayout="relayout"
          @edit-node="openEditNode"
          @edit-edge="openEditEdge"
          @delete-node="confirmDeleteNode"
          @delete-nodes="confirmDeleteNodes"
          @delete-edge="confirmDeleteEdge"
          @focus-node="setFocusedGraphNode"
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
        title="Remove Memory Folder"
        icon="lucide:trash-2"
        icon-color="red"
        @close="showDeleteConfirm = false"
      >
        <p class="text-theme-400 leading-relaxed">
          Remove <strong class="text-theme-200">{{ pendingDeleteSpace?.name }}</strong>? Its folder will be moved to the memory trash and its indexes will be removed.
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="deleteSpace(pendingDeleteSpace!)"
          >
            Remove Folder
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
                <label class="block text-xs text-theme-400 mb-1">Note</label>
                <textarea
                  v-model="edgeNote"
                  rows="3"
                  class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-theme-500 resize-none"
                />
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
            :disabled="graphMutationPending"
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 disabled:cursor-wait disabled:opacity-60 text-white rounded-xl text-center font-medium transition-colors"
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
            :disabled="graphMutationPending"
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 disabled:cursor-wait disabled:opacity-60 text-white rounded-xl text-center font-medium transition-colors"
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
            :disabled="graphMutationPending"
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 disabled:cursor-wait disabled:opacity-60 text-white rounded-xl text-center font-medium transition-colors"
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
