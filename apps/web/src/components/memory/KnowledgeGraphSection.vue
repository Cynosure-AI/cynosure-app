<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  VueFlow,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useVueFlow,
  type Edge,
  type EdgeProps,
  type Node,
} from "@vue-flow/core";
import { Controls } from "@vue-flow/controls";
import { Icon } from "@iconify/vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "./knowledge-graph.css";
import type { KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraphNodeType, KnowledgeGraph } from "../../api/types";
import type { FlowEdgeData, FlowNodeData, GraphEdgePathType } from "./knowledge-graph-types";
import KnowledgeGraphSearchBox from "./KnowledgeGraphSearchBox.vue";
import KnowledgeGraphInspector from "./KnowledgeGraphInspector.vue";

type FactLevelFilter = 0 | 1 | 2 | 3;
type GraphEntityLimit = 100 | 200 | 300 | 500 | null;

const props = defineProps<{
  flowId: string;
  graph: KnowledgeGraph | null;
  graphLoading: boolean;
  graphQuery: string;
  graphSearchQuery: string;
  graphSuggestions: KnowledgeGraphNode[];
  walkNodes: KnowledgeGraphNode[];
  graphFlowNodes: Node<FlowNodeData>[];
  graphFlowEdges: Edge<FlowEdgeData>[];
  nodeSpacing: number;
  edgeLabelsVisible: boolean;
  edgePathType: GraphEdgePathType;
  factLevel: FactLevelFilter;
  entityLimit: GraphEntityLimit;
}>();

const edgePathModes: { id: GraphEdgePathType; label: string; icon: string }[] = [
  { id: "bezier", label: "Bezier", icon: "lucide:spline" },
  { id: "step", label: "Step", icon: "lucide:corner-down-right" },
  { id: "straight", label: "Line", icon: "lucide:slash" },
];

const factLevelOptions: { value: FactLevelFilter; label: string }[] = [
  { value: 0, label: "All levels" },
  { value: 1, label: "Minor+" },
  { value: 2, label: "Useful+" },
  { value: 3, label: "Core" },
];

const entityLimitOptions: { value: GraphEntityLimit; label: string }[] = [
  { value: 100, label: "100" },
  { value: 200, label: "200" },
  { value: 300, label: "300" },
  { value: 500, label: "500" },
  { value: null, label: "All" },
];

const entityCategories: { type: KnowledgeGraphNodeType; label: string; icon: string }[] = [
  { type: "person", label: "Person", icon: "lucide:user" },
  { type: "organization", label: "Organization", icon: "lucide:building-2" },
  { type: "place", label: "Place", icon: "lucide:map-pin" },
  { type: "concept", label: "Concept", icon: "lucide:lightbulb" },
  { type: "event", label: "Event", icon: "lucide:calendar-days" },
  { type: "date", label: "Date", icon: "lucide:calendar" },
  { type: "technology", label: "Technology", icon: "lucide:box" },
  { type: "product", label: "Product", icon: "lucide:package" },
  { type: "project", label: "Project", icon: "lucide:folder-kanban" },
  { type: "artifact", label: "Artifact", icon: "lucide:file-box" },
  { type: "other", label: "Other", icon: "lucide:circle-ellipsis" },
];

const categoryByType = new Map(entityCategories.map((category) => [category.type, category]));
const visibleCategories = computed(() => {
  const presentTypes = new Set(props.graph?.nodes.map((node) => node.type) || []);
  return entityCategories.filter((category) => presentTypes.has(category.type));
});

const emit = defineEmits<{
  "update:graphQuery": [value: string];
  "update:nodeSpacing": [value: number];
  "update:edgeLabelsVisible": [value: boolean];
  "update:edgePathType": [value: GraphEdgePathType];
  "update:factLevel": [value: FactLevelFilter];
  "update:entityLimit": [value: GraphEntityLimit];
  "load-graph": [query?: string];
  "clear-walk": [];
  "select-suggestion": [node: KnowledgeGraphNode];
  "explore-node": [node: KnowledgeGraphNode];
  "remove-selected-node": [nodeId: string];
  "relayout": [];
  "edit-node": [node: KnowledgeGraphNode];
  "delete-node": [node: KnowledgeGraphNode];
  "delete-nodes": [nodes: KnowledgeGraphNode[]];
  "edit-edge": [edge: KnowledgeGraphEdge];
  "delete-edge": [edge: KnowledgeGraphEdge];
  "focus-node": [nodeId: string | null];
}>();

const selectedNodeId = ref<string | null>(null);
const selectedEdgeId = ref<string | null>(null);
const graphPanel = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
const { fitView, getSelectedNodes, removeSelectedElements } = useVueFlow(props.flowId);

function syncFullscreenState(): void {
  isFullscreen.value = document.fullscreenElement === graphPanel.value;
  requestAnimationFrame(() => void fitView({ padding: 0.1 }));
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement === graphPanel.value) {
    await document.exitFullscreen();
    return;
  }
  await graphPanel.value?.requestFullscreen();
}

onMounted(() => document.addEventListener("fullscreenchange", syncFullscreenState));
onBeforeUnmount(() => document.removeEventListener("fullscreenchange", syncFullscreenState));

const selectedFlowNode = computed(() =>
  props.graphFlowNodes.find((node) => node.id === selectedNodeId.value) || null,
);

const selectedFlowNodes = computed(() => {
  const selectedIds = new Set(getSelectedNodes.value.map((node) => node.id));
  if (selectedIds.size > 0) {
    return props.graphFlowNodes.filter((node) => selectedIds.has(node.id));
  }
  return selectedFlowNode.value ? [selectedFlowNode.value] : [];
});

const selectedGraphNodes = computed(() =>
  selectedFlowNodes.value
    .map((node) => node.data?.entity)
    .filter((node): node is KnowledgeGraphNode => Boolean(node)),
);

const selectedGraphEdge = computed(() =>
  props.graph?.edges.find((edge) => edge.id === selectedEdgeId.value) || null,
);

const isWalkView = computed(() => Boolean(props.graphSearchQuery.trim() || props.walkNodes.length));

watch(() => props.graph, (graph) => {
  selectedEdgeId.value = null;
  removeSelectedElements();

  const visibleNodeIds = new Set(graph?.nodes.map((node) => node.id) || []);
  const newestWalkMatch = [...props.walkNodes].reverse().find((node) => visibleNodeIds.has(node.id));
  const primarySearchMatch = newestWalkMatch
    || graph?.seedNodes.find((node) => visibleNodeIds.has(node.id))
    || null;
  selectedNodeId.value = primarySearchMatch?.id || null;
  emit("focus-node", selectedNodeId.value);
});

watch(() => props.graphFlowNodes, (nodes) => {
  if (selectedNodeId.value && !nodes.some((node) => node.id === selectedNodeId.value)) {
    selectedNodeId.value = null;
  }
  if (getSelectedNodes.value.some((selectedNode) => !nodes.some((node) => node.id === selectedNode.id))) {
    removeSelectedElements();
  }
});

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function changeEntityLimit(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit("update:entityLimit", value === "all" ? null : Number(value) as GraphEntityLimit);
  emit("load-graph", props.graphQuery);
}

function importanceLabel(level: number): string {
  return ["temporary", "minor", "useful", "core"][level] ?? "minor";
}

function entityIcon(type: KnowledgeGraphNodeType): string {
  return categoryByType.get(type)?.icon || "lucide:circle-ellipsis";
}

function changeFactLevel(event: Event): void {
  const nextLevel = Number((event.target as HTMLSelectElement).value) as FactLevelFilter;
  emit("update:factLevel", nextLevel);
  emit("load-graph", props.graphQuery);
}

function selectGraphNode(event: { node: Node<FlowNodeData> }): void {
  selectedEdgeId.value = null;
  selectedNodeId.value = event.node.id;
  emit("focus-node", event.node.id);
}

function selectGraphEdge(edgeId: string, event: MouseEvent): void {
  event.stopPropagation();
  selectedEdgeId.value = edgeId;
  selectedNodeId.value = null;
  removeSelectedElements();
  emit("focus-node", null);
}

function clearSelection(): void {
  selectedNodeId.value = null;
  selectedEdgeId.value = null;
  removeSelectedElements();
  emit("focus-node", null);
}

function stackedEdgePath(edge: EdgeProps<FlowEdgeData>): ReturnType<typeof getBezierPath> {
  const pathOptions = {
    sourceX: edge.sourceX,
    sourceY: edge.sourceY,
    sourcePosition: edge.sourcePosition,
    targetX: edge.targetX,
    targetY: edge.targetY,
    targetPosition: edge.targetPosition,
  };
  if (props.edgePathType === "straight") return getStraightPath(pathOptions);
  if (props.edgePathType === "step") return getSmoothStepPath({ ...pathOptions, borderRadius: 0 });
  return getBezierPath(pathOptions);
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-8">
    <div class="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <form
        class="flex items-start gap-2"
        @submit.prevent="emit('load-graph', graphQuery)"
      >
        <KnowledgeGraphSearchBox
          :model-value="graphQuery"
          :suggestions="graphSuggestions"
          :selected-node-ids="walkNodes.map((node) => node.id)"
          placeholder="Search entities"
          @update:model-value="emit('update:graphQuery', $event)"
          @select-suggestion="emit('select-suggestion', $event)"
        />
        <button
          class="p-2 bg-accent-600 hover:bg-accent-500 text-accent-on rounded-lg transition-colors"
          title="Walk graph"
        >
          <Icon
            icon="lucide:route"
            class="w-4 h-4"
          />
        </button>
        <button
          v-if="isWalkView"
          type="button"
          class="p-2 text-theme-500 hover:text-theme-200 transition-colors"
          title="Show full graph"
          @click="emit('clear-walk')"
        >
          <Icon
            icon="lucide:x"
            class="w-4 h-4"
          />
        </button>
      </form>
    </div>

    <p class="mb-4 flex flex-wrap items-center gap-1 text-xs text-theme-500">
      <span v-if="graph">
        Showing {{ formatCount(graph.nodes.length) }} of {{ formatCount(graph.stats.nodeCount) }} entities,
        {{ formatCount(graph.edges.length) }} of {{ formatCount(graph.stats.edgeCount) }} relations.
        <span class="ml-1">Maximum entities</span>
        <select
          :value="entityLimit ?? 'all'"
          class="h-6 rounded border border-theme-700/60 bg-theme-950/70 px-1.5 text-xs text-theme-300 outline-none transition-colors focus:border-accent-500"
          aria-label="Maximum entities to show"
          title="Maximum entities to show"
          @change="changeEntityLimit"
        >
          <option
            v-for="option in entityLimitOptions"
            :key="option.label"
            :value="option.value ?? 'all'"
          >
            {{ option.label }}
          </option>
        </select>
        <span
          v-if="entityLimit !== null && graph.stats.nodeCount > graph.nodes.length"
          class="ml-1"
        >
          Connected neighborhoods are prioritized; standalone entries are omitted.
        </span>
      </span>
      <span v-else>
        Search walks outward from matching entities and refocuses the canvas on that neighborhood.
      </span>
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
        v-if="walkNodes.length"
        class="mb-4 flex flex-wrap gap-2"
      >
        <button
          v-for="node in walkNodes"
          :key="node.id"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-accent-500/30 bg-accent-500/10 px-2 py-1 text-xs text-accent-fg"
          :title="`Remove ${node.name} from the graph walk`"
          @click="emit('remove-selected-node', node.id)"
        >
          <Icon
            icon="lucide:sparkles"
            class="w-3 h-3"
          />
          {{ node.name }}
          <span class="text-accent-fg/70">{{ node.type }}</span>
          <Icon
            icon="lucide:x"
            class="h-3 w-3 text-accent-fg/70"
          />
        </button>
      </div>

      <div
        v-if="graph.edges.length === 0"
        class="py-12 text-center text-sm text-theme-500"
      >
        No relationships have been extracted yet.
      </div>

      <div
        v-else
        ref="graphPanel"
        class="knowledge-graph-panel isolate relative h-[calc(100vh-310px)] min-h-[560px] rounded-lg border border-theme-800 bg-theme-950 overflow-hidden"
      >
        <div class="absolute top-2 left-2 z-10 flex flex-wrap items-center justify-start gap-2 bg-theme-900/80 backdrop-blur-sm border border-theme-700/60 rounded-lg px-3 py-1.5">
          <label class="flex items-center gap-2">
            <Icon
              icon="lucide:filter"
              class="w-3.5 h-3.5 text-theme-500 shrink-0"
            />
            <span class="text-xs text-theme-500 shrink-0">Fact level</span>
            <select
              :value="factLevel"
              class="h-7 rounded-md border border-theme-700/60 bg-theme-950/70 px-2 text-xs text-theme-200 outline-none transition-colors focus:border-accent-500"
              title="Minimum fact level"
              @change="changeFactLevel"
            >
              <option
                v-for="option in factLevelOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <div class="h-5 w-px bg-theme-700/70" />
          <label class="flex items-center gap-2">
            <Icon
              icon="lucide:move"
              class="w-3.5 h-3.5 text-theme-500 shrink-0"
            />
            <span class="text-xs text-theme-500 shrink-0">Spacing</span>
            <input
              :value="nodeSpacing"
              type="range"
              min="0.5"
              max="8"
              step="0.25"
              class="w-32 accent-accent-500 cursor-pointer"
              title="Node spacing"
              @input="emit('update:nodeSpacing', Number(($event.target as HTMLInputElement).value))"
              @change="emit('relayout')"
            >
            <span class="text-xs text-theme-300 w-8 text-right">{{ nodeSpacing }}x</span>
          </label>
          <div class="h-5 w-px bg-theme-700/70" />
          <div class="flex items-center gap-1">
            <Icon
              icon="lucide:git-branch"
              class="w-3.5 h-3.5 text-theme-500 shrink-0"
            />
            <span class="text-xs text-theme-500 shrink-0">Edges</span>
            <div class="inline-flex rounded-md border border-theme-700/60 bg-theme-950/55 p-0.5">
              <button
                v-for="mode in edgePathModes"
                :key="mode.id"
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded text-xs transition-colors"
                :class="edgePathType === mode.id ? 'bg-accent-500/18 text-accent-fg' : 'text-theme-500 hover:bg-theme-800 hover:text-theme-200'"
                :title="`${mode.label} edges`"
                :aria-pressed="edgePathType === mode.id"
                @click="emit('update:edgePathType', mode.id)"
              >
                <Icon
                  :icon="mode.icon"
                  class="h-3.5 w-3.5"
                />
              </button>
            </div>
          </div>
          <div class="h-5 w-px bg-theme-700/70" />
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors"
            :class="edgeLabelsVisible ? 'bg-accent-500/15 text-accent-fg' : 'text-theme-500 hover:bg-theme-800 hover:text-theme-200'"
            :title="edgeLabelsVisible ? 'Hide edge labels' : 'Show edge labels'"
            :aria-pressed="edgeLabelsVisible"
            @click="emit('update:edgeLabelsVisible', !edgeLabelsVisible)"
          >
            <Icon
              icon="lucide:tag"
              class="w-3.5 h-3.5"
            />
            Labels
          </button>
          <div class="h-5 w-px bg-theme-700/70" />
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200"
            :title="isFullscreen ? 'Exit full screen' : 'Enter full screen'"
            :aria-label="isFullscreen ? 'Exit full screen' : 'Enter full screen'"
            :aria-pressed="isFullscreen"
            @click="toggleFullscreen"
          >
            <Icon
              :icon="isFullscreen ? 'lucide:minimize-2' : 'lucide:maximize-2'"
              class="h-3.5 w-3.5"
            />
            {{ isFullscreen ? "Exit full screen" : "Full screen" }}
          </button>
        </div>
        <VueFlow
          :id="flowId"
          :nodes="graphFlowNodes"
          :edges="graphFlowEdges"
          fit-view-on-init
          :min-zoom="0.2"
          :max-zoom="1.8"
          class="entity-flow"
          @node-click="selectGraphNode"
          @node-double-click="emit('explore-node', $event.node.data.entity)"
        >
          <template #edge-stacked="edgeProps">
            <BaseEdge
              :id="edgeProps.id"
              :path="stackedEdgePath(edgeProps)[0]"
              :marker-start="edgeProps.markerStart"
              :marker-end="edgeProps.markerEnd"
              :style="edgeProps.style"
              :interaction-width="edgeProps.interactionWidth"
            />
            <EdgeLabelRenderer v-if="edgeLabelsVisible">
              <div
                class="entity-edge-label-stack nodrag nopan"
                :class="{
                  'entity-edge-label-stack-focus-highlighted': edgeProps.data.isFocusHighlighted,
                  'entity-edge-label-stack-focus-dimmed': edgeProps.data.isFocusDimmed,
                }"
                :style="{
                  transform: `translate(-50%, -50%) translate(${stackedEdgePath(edgeProps)[1]}px, ${stackedEdgePath(edgeProps)[2]}px)`,
                }"
              >
                <template v-if="edgeProps.data.isBidirectional">
                  <div
                    v-for="group in edgeProps.data.labelGroups"
                    :key="`${group.fromNodeId}->${group.toNodeId}`"
                    class="entity-edge-label-direction"
                  >
                    <div class="entity-edge-label-direction-title">
                      <span>{{ group.fromName }}</span>
                      <Icon
                        icon="lucide:arrow-right"
                        class="w-3 h-3 shrink-0"
                      />
                      <span>{{ group.toName }}</span>
                    </div>
                    <button
                      v-for="relationship in group.relationships"
                      :key="relationship.id"
                      type="button"
                      class="entity-edge-label-row"
                      :class="{ 'entity-edge-label-row-selected': selectedEdgeId === relationship.id }"
                      @click="selectGraphEdge(relationship.id, $event)"
                    >
                      {{ relationship.label }}
                    </button>
                  </div>
                </template>
                <template v-else>
                  <button
                    v-for="(relationship, index) in edgeProps.data.relationships"
                    :key="relationship.id"
                    type="button"
                    class="entity-edge-label-row"
                    :class="{ 'entity-edge-label-row-selected': selectedEdgeId === relationship.id }"
                    @click="selectGraphEdge(relationship.id, $event)"
                  >
                    {{ relationship.label }}
                    <hr
                      v-if="+index < edgeProps.data.relationships.length - 1"
                      class="entity-edge-label-separator mt-1 mb-0 border-theme-700/50"
                    >
                  </button>
                </template>
              </div>
            </EdgeLabelRenderer>
          </template>

          <template #node-entity="{ data, selected }">
            <div
              class="entity-node-body"
              :class="{
                'entity-node-body-selected': selected || selectedNodeId === data.entity.id,
                'entity-node-body-focus-root': data.isFocusRoot,
                'entity-node-body-focus-highlighted': data.isFocusHighlighted,
                'entity-node-body-focus-dimmed': data.isFocusDimmed,
              }"
            >
              <div
                class="entity-node-icon"
                aria-hidden="true"
              >
                <Icon :icon="entityIcon(data.entity.type)" />
              </div>
              <div class="entity-node-content">
                <div class="entity-node-label">
                  {{ data.label }}
                </div>
                <div class="entity-node-meta">
                  <span class="entity-node-type">
                    {{ data.entity.type }}
                  </span>
                  <span
                    v-if="data.entity.importance > 0"
                    class="entity-node-importance"
                    :class="`entity-node-importance-${data.entity.importance}`"
                    :title="importanceLabel(data.entity.importance)"
                  >
                    {{ importanceLabel(data.entity.importance) }}
                  </span>
                </div>
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

          <Controls />
        </VueFlow>

        <div
          v-if="visibleCategories.length"
          class="entity-category-legend"
          aria-label="Entity category legend"
        >
          <div
            v-for="category in visibleCategories"
            :key="category.type"
            class="entity-category-legend-item"
            :class="`entity-category-${category.type}`"
          >
            <span class="entity-category-legend-dot" />
            {{ category.label }}
          </div>
        </div>

        <KnowledgeGraphInspector
          v-if="selectedGraphNodes.length || selectedGraphEdge"
          :selected-graph-nodes="selectedGraphNodes"
          :selected-graph-edge="selectedGraphEdge"
          :graph-edges="graph?.edges || []"
          @close="clearSelection"
          @explore-node="emit('explore-node', $event)"
          @edit-node="emit('edit-node', $event)"
          @delete-node="emit('delete-node', $event)"
          @delete-nodes="emit('delete-nodes', $event)"
          @edit-edge="emit('edit-edge', $event)"
          @delete-edge="emit('delete-edge', $event)"
        />
      </div>
    </template>
  </div>
</template>
