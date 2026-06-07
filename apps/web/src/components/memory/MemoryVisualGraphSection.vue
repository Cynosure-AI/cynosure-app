<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  VueFlow,
  getBezierPath,
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
import "./memory-visual-graph.css";
import type { EntityGraphEdge, EntityGraphNode, EntityGraphResponse } from "../../api/types";
import type { FlowEdgeData, FlowNodeData } from "./memory-graph-types";
import EntityGraphSearchBox from "./EntityGraphSearchBox.vue";

const props = defineProps<{
  flowId: string;
  graph: EntityGraphResponse | null;
  graphLoading: boolean;
  graphQuery: string;
  graphSuggestions: EntityGraphNode[];
  graphFlowNodes: Node<FlowNodeData>[];
  graphFlowEdges: Edge<FlowEdgeData>[];
  nodeSpacing: number;
  edgeLabelsVisible: boolean;
}>();

const emit = defineEmits<{
  "update:graphQuery": [value: string];
  "update:nodeSpacing": [value: number];
  "update:edgeLabelsVisible": [value: boolean];
  "load-graph": [query?: string];
  "clear-walk": [];
  "select-suggestion": [node: EntityGraphNode];
  "relayout": [];
  "edit-node": [node: EntityGraphNode];
  "delete-node": [node: EntityGraphNode];
  "delete-nodes": [nodes: EntityGraphNode[]];
}>();

const selectedNodeId = ref<string | null>(null);
const { getSelectedNodes, removeSelectedElements } = useVueFlow(props.flowId);

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
    .filter((node): node is EntityGraphNode => Boolean(node)),
);

const selectedGraphNode = computed(() =>
  selectedGraphNodes.value.length === 1 ? selectedGraphNodes.value[0] : null,
);

const selectedNodeIds = computed(() => new Set(selectedGraphNodes.value.map((node) => node.id)));

const sidebarVisible = computed(() => selectedGraphNodes.value.length > 0);

const sidebarTitle = computed(() => {
  if (selectedGraphNode.value) return selectedGraphNode.value.name;
  return `${formatCount(selectedGraphNodes.value.length)} entities selected`;
});

const selectedMentionCount = computed(() =>
  selectedGraphNodes.value.reduce((total, node) => total + node.mentionCount, 0),
);

const selectedSourceCount = computed(() =>
  selectedGraphNodes.value.reduce((total, node) => total + node.sourceCount, 0),
);

const selectedNodeAliases = computed(() => selectedGraphNode.value?.aliases || []);

const selectedNodeRelationships = computed(() => {
  if (selectedNodeIds.value.size === 0 || !props.graph) return [];
  return props.graph.edges
    .filter((edge) => selectedNodeIds.value.has(edge.fromNodeId) || selectedNodeIds.value.has(edge.toNodeId))
    .sort((a, b) => {
      const confidenceDelta = (b.confidence || 0) - (a.confidence || 0);
      if (confidenceDelta !== 0) return confidenceDelta;
      return relationSortName(a).localeCompare(relationSortName(b));
    });
});

watch(() => props.graph, () => {
  clearSelection();
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

function formatRelation(relation: string): string {
  return relation.replace(/_/g, " ");
}

function formatConfidence(value: number): string {
  return `${Math.round((value || 0) * 100)}%`;
}

function relationSortName(edge: EntityGraphEdge): string {
  return `${edge.fromName} ${edge.toName}`;
}

function selectGraphNode(event: { node: Node<FlowNodeData> }): void {
  selectedNodeId.value = event.node.id;
}

function clearSelection(): void {
  selectedNodeId.value = null;
  removeSelectedElements();
}

function deleteSelectedNodes(): void {
  if (selectedGraphNodes.value.length === 1) {
    emit("delete-node", selectedGraphNodes.value[0]);
    return;
  }
  emit("delete-nodes", selectedGraphNodes.value);
}

function stackedEdgePath(edge: EdgeProps<FlowEdgeData>): ReturnType<typeof getBezierPath> {
  return getBezierPath({
    sourceX: edge.sourceX,
    sourceY: edge.sourceY,
    sourcePosition: edge.sourcePosition,
    targetX: edge.targetX,
    targetY: edge.targetY,
    targetPosition: edge.targetPosition,
  });
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-8">
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
        class="flex items-start gap-2"
        @submit.prevent="emit('load-graph', graphQuery)"
      >
        <EntityGraphSearchBox
          :model-value="graphQuery"
          :suggestions="graphSuggestions"
          placeholder="Search entities"
          @update:model-value="emit('update:graphQuery', $event)"
          @select-suggestion="emit('select-suggestion', $event)"
        />
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
          @click="emit('clear-walk')"
        >
          <Icon
            icon="lucide:x"
            class="w-4 h-4"
          />
        </button>
      </form>
    </div>

    <p class="mb-4 text-xs text-theme-500">
      <span v-if="graph">
        Showing {{ formatCount(graph.nodes.length) }} of {{ formatCount(graph.stats.nodeCount) }} entities,
        {{ formatCount(graph.edges.length) }} of {{ formatCount(graph.stats.edgeCount) }} relations.
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
        v-else
        class="memory-graph-panel relative h-[calc(100vh-255px)] min-h-[560px] rounded-lg border border-theme-800 bg-theme-950 overflow-hidden"
      >
        <div class="absolute top-2 right-2 z-10 flex flex-wrap items-center justify-end gap-2 bg-theme-900/80 backdrop-blur-sm border border-theme-700/60 rounded-lg px-3 py-1.5">
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
              max="3"
              step="0.25"
              class="w-24 accent-accent-500 cursor-pointer"
              title="Node spacing"
              @input="emit('update:nodeSpacing', Number(($event.target as HTMLInputElement).value))"
              @change="emit('relayout')"
            >
            <span class="text-xs text-theme-300 w-6 text-right">{{ nodeSpacing }}x</span>
          </label>
          <div class="h-5 w-px bg-theme-700/70" />
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors"
            :class="edgeLabelsVisible ? 'bg-accent-500/15 text-accent-200' : 'text-theme-500 hover:bg-theme-800 hover:text-theme-200'"
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
                    <div
                      v-for="(label, index) in group.labels"
                      :key="`${label}-${index}`"
                      class="entity-edge-label-row"
                    >
                      {{ label }}
                    </div>
                  </div>
                </template>
                <template v-else>
                  <div
                    v-for="(label, index) in edgeProps.data.labels"
                    :key="`${label}-${index}`"
                    class="entity-edge-label-row"
                  >
                    {{ label }}
                    <hr
                      v-if="+index < edgeProps.data.labels.length - 1"
                      class="entity-edge-label-separator mt-1 mb-0 border-theme-700/50"
                    >
                  </div>
                </template>
              </div>
            </EdgeLabelRenderer>
          </template>

          <template #node-entity="{ data, selected }">
            <div
              class="entity-node-body"
              :class="{ 'entity-node-body-selected': selected || selectedNodeId === data.entity.id }"
            >
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

          <Controls />
        </VueFlow>

        <aside
          v-if="sidebarVisible"
          class="entity-node-sidebar"
        >
          <header class="entity-node-sidebar-header">
            <div class="min-w-0">
              <h3 class="entity-node-sidebar-title">
                {{ sidebarTitle }}
              </h3>
              <div class="entity-node-sidebar-meta">
                <span>{{ selectedGraphNode?.type || "selection" }}</span>
                <span>{{ formatCount(selectedMentionCount) }} mentions</span>
                <span>{{ formatCount(selectedSourceCount) }} sources</span>
              </div>
            </div>
            <button
              type="button"
              class="entity-node-sidebar-close"
              title="Close"
              @click="clearSelection"
            >
              <Icon
                icon="lucide:x"
                class="h-4 w-4"
              />
            </button>
          </header>

          <div
            v-if="selectedNodeAliases.length"
            class="entity-node-sidebar-aliases"
          >
            <span
              v-for="alias in selectedNodeAliases"
              :key="alias"
              class="entity-node-sidebar-alias"
            >
              {{ alias }}
            </span>
          </div>

          <div
            v-if="selectedGraphNodes.length > 1"
            class="entity-node-sidebar-selection-list"
          >
            <span
              v-for="node in selectedGraphNodes"
              :key="node.id"
              class="entity-node-sidebar-selection-item"
            >
              {{ node.name }}
            </span>
          </div>

          <div class="entity-node-sidebar-actions">
            <button
              v-if="selectedGraphNode"
              type="button"
              class="entity-node-sidebar-action"
              @click="emit('edit-node', selectedGraphNode)"
            >
              <Icon
                icon="lucide:pencil"
                class="h-4 w-4"
              />
              Edit
            </button>
            <button
              type="button"
              class="entity-node-sidebar-action entity-node-sidebar-action-danger"
              @click="deleteSelectedNodes"
            >
              <Icon
                icon="lucide:trash-2"
                class="h-4 w-4"
              />
              {{ selectedGraphNodes.length > 1 ? `Delete ${selectedGraphNodes.length}` : "Delete" }}
            </button>
          </div>

          <div class="entity-node-sidebar-divider" />

          <div class="entity-node-sidebar-section-header">
            <span>Relationships</span>
            <span>{{ formatCount(selectedNodeRelationships.length) }}</span>
          </div>

          <div
            v-if="selectedNodeRelationships.length"
            class="entity-node-sidebar-list"
          >
            <div
              v-for="edge in selectedNodeRelationships"
              :key="edge.id"
              class="entity-node-sidebar-relation"
            >
              <div class="entity-node-sidebar-relation-path">
                <span>{{ edge.fromName }}</span>
                <Icon
                  icon="lucide:arrow-right"
                  class="h-3 w-3 shrink-0 text-theme-600"
                />
                <span>{{ edge.toName }}</span>
              </div>
              <div class="entity-node-sidebar-relation-detail">
                <span>{{ formatRelation(edge.relation) }}</span>
                <span>{{ formatConfidence(edge.confidence) }}</span>
              </div>
            </div>
          </div>

          <div
            v-else
            class="entity-node-sidebar-empty"
          >
            No relationships for this entity.
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>
