<script setup lang="ts">
import { Handle, Position, VueFlow, type Edge, type Node } from "@vue-flow/core";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import { NodeToolbar } from "@vue-flow/node-toolbar";
import { Icon } from "@iconify/vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import type { EntityGraphNode, EntityGraphNodeType, EntityGraphResponse } from "../../api/types";
import type { FlowNodeData } from "./memory-graph-types";

defineProps<{
  flowId: string;
  graph: EntityGraphResponse | null;
  graphLoading: boolean;
  graphQuery: string;
  graphSuggestions: EntityGraphNode[];
  graphFlowNodes: Node<FlowNodeData>[];
  graphFlowEdges: Edge[];
  nodeSpacing: number;
}>();

const emit = defineEmits<{
  "update:graphQuery": [value: string];
  "update:nodeSpacing": [value: number];
  "load-graph": [query?: string];
  "clear-walk": [];
  "select-suggestion": [node: EntityGraphNode];
  "relayout": [];
  "edit-node": [node: EntityGraphNode];
  "delete-node": [node: EntityGraphNode];
}>();

const ENTITY_TYPE_COLORS: Record<EntityGraphNodeType, string> = {
  person: "var(--memory-flow-person-fill)",
  place: "var(--memory-flow-place-fill)",
  organization: "var(--memory-flow-organization-fill)",
  project: "var(--memory-flow-project-fill)",
  event: "var(--memory-flow-event-fill)",
  date: "var(--memory-flow-date-fill)",
  technology: "var(--memory-flow-technology-fill)",
  product: "var(--memory-flow-product-fill)",
  artifact: "var(--memory-flow-artifact-fill)",
  concept: "var(--memory-flow-concept-fill)",
  other: "var(--memory-flow-node-fill)",
};

function minimapNodeColor(node: Node<FlowNodeData>): string {
  if (typeof node.class === "string" && node.class.includes("entity-flow-node-seed")) {
    return "var(--memory-flow-seed-fill)";
  }
  return ENTITY_TYPE_COLORS[node.data?.entity.type || "other"];
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
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
        <div class="relative">
          <Icon
            icon="lucide:search"
            class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-600"
          />
          <input
            :value="graphQuery"
            type="text"
            class="w-72 max-w-full pl-8 pr-3 py-2 text-sm bg-theme-950 border border-theme-800 rounded-lg text-theme-200 placeholder-theme-600 focus:outline-none focus:border-theme-600"
            placeholder="Search entities"
            @input="emit('update:graphQuery', ($event.target as HTMLInputElement).value)"
          >
          <div
            v-if="graphSuggestions.length > 0 && graphQuery.trim()"
            class="absolute left-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-theme-700 bg-theme-950 shadow-2xl"
          >
            <button
              v-for="node in graphSuggestions"
              :key="node.id"
              type="button"
              class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-theme-300 transition-colors hover:bg-theme-800 hover:text-theme-100"
              @mousedown.prevent="emit('select-suggestion', node)"
            >
              <span class="truncate">{{ node.name }}</span>
              <span class="shrink-0 rounded-md border border-theme-700 bg-theme-900 px-1.5 py-0.5 text-[10px] text-theme-500">
                {{ node.type }}
              </span>
            </button>
          </div>
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
        <div class="absolute top-2 right-2 z-10 flex items-center gap-2 bg-theme-900/80 backdrop-blur-sm border border-theme-700/60 rounded-lg px-3 py-1.5">
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
        </div>
        <VueFlow
          :id="flowId"
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
                @click.stop="emit('edit-node', data.entity)"
              >
                <Icon
                  icon="lucide:pencil"
                  class="w-3.5 h-3.5"
                />
              </button>
              <button
                type="button"
                title="Delete entity"
                @click.stop="emit('delete-node', data.entity)"
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

          <Controls />

          <MiniMap
            :node-color="minimapNodeColor"
            :node-stroke-color="() => 'var(--memory-flow-node-border)'"
            :node-border-radius="4"
            mask-color="var(--memory-flow-minimap-mask)"
          />
        </VueFlow>
      </div>
    </template>
  </div>
</template>

<style scoped>
.memory-graph-panel {
  --memory-flow-bg: color-mix(in srgb, var(--color-theme-950) 92%, black);
  --memory-flow-grid: color-mix(in srgb, var(--color-theme-700) 28%, transparent);
  --memory-flow-node-fill: color-mix(in srgb, var(--color-theme-900) 88%, var(--color-accent-500) 12%);
  --memory-flow-node-border: color-mix(in srgb, var(--color-accent-500) 52%, var(--color-theme-700));
  --memory-flow-node-text: var(--color-theme-100);
  --memory-flow-node-muted: color-mix(in srgb, var(--color-accent-300) 68%, var(--color-theme-400));
  --memory-flow-person-fill: color-mix(in srgb, #0f766e 52%, var(--color-theme-950));
  --memory-flow-person-border: color-mix(in srgb, #2dd4bf 70%, var(--color-theme-700));
  --memory-flow-place-fill: color-mix(in srgb, #166534 52%, var(--color-theme-950));
  --memory-flow-place-border: color-mix(in srgb, #4ade80 70%, var(--color-theme-700));
  --memory-flow-organization-fill: color-mix(in srgb, #1d4ed8 54%, var(--color-theme-950));
  --memory-flow-organization-border: color-mix(in srgb, #60a5fa 72%, var(--color-theme-700));
  --memory-flow-project-fill: color-mix(in srgb, #7c3aed 50%, var(--color-theme-950));
  --memory-flow-project-border: color-mix(in srgb, #a78bfa 72%, var(--color-theme-700));
  --memory-flow-event-fill: color-mix(in srgb, #be123c 48%, var(--color-theme-950));
  --memory-flow-event-border: color-mix(in srgb, #fb7185 72%, var(--color-theme-700));
  --memory-flow-date-fill: color-mix(in srgb, #854d0e 48%, var(--color-theme-950));
  --memory-flow-date-border: color-mix(in srgb, #facc15 68%, var(--color-theme-700));
  --memory-flow-technology-fill: color-mix(in srgb, #0891b2 52%, var(--color-theme-950));
  --memory-flow-technology-border: color-mix(in srgb, #22d3ee 72%, var(--color-theme-700));
  --memory-flow-product-fill: color-mix(in srgb, #c2410c 48%, var(--color-theme-950));
  --memory-flow-product-border: color-mix(in srgb, #fb923c 72%, var(--color-theme-700));
  --memory-flow-artifact-fill: color-mix(in srgb, #b45309 48%, var(--color-theme-950));
  --memory-flow-artifact-border: color-mix(in srgb, #fbbf24 70%, var(--color-theme-700));
  --memory-flow-concept-fill: color-mix(in srgb, #4338ca 50%, var(--color-theme-950));
  --memory-flow-concept-border: color-mix(in srgb, #818cf8 72%, var(--color-theme-700));
  --memory-flow-seed-fill: color-mix(in srgb, var(--color-accent-900) 42%, var(--color-theme-900));
  --memory-flow-seed-border: color-mix(in srgb, var(--color-accent-400) 78%, var(--color-theme-100));
  --memory-flow-edge: color-mix(in srgb, var(--color-accent-500) 82%, var(--color-theme-300));
  --memory-flow-edge-label-bg: color-mix(in srgb, var(--color-theme-950) 90%, var(--color-accent-900));
  --memory-flow-shadow: color-mix(in srgb, black 28%, transparent);
  --memory-flow-minimap-mask: color-mix(in srgb, var(--color-theme-950) 72%, transparent);
}

:deep(.entity-flow) {
  background:
    radial-gradient(circle at 20px 20px, var(--memory-flow-grid) 1px, transparent 1px),
    var(--memory-flow-bg);
  background-size: 28px 28px;
}

:deep(.entity-flow-node) {
  border: 1px solid var(--memory-flow-node-border);
  background: var(--memory-flow-node-fill);
  color: var(--memory-flow-node-text);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 10px 22px var(--memory-flow-shadow);
}

:deep(.entity-flow-node-seed) {
  border-color: var(--memory-flow-seed-border);
  background: var(--memory-flow-seed-fill);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-accent-400) 24%, transparent),
    0 14px 28px var(--memory-flow-shadow);
}

:deep(.entity-flow-node-type-person) {
  --memory-flow-node-fill: var(--memory-flow-person-fill);
  --memory-flow-node-border: var(--memory-flow-person-border);
  --memory-flow-node-muted: color-mix(in srgb, #99f6e4 78%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-place) {
  --memory-flow-node-fill: var(--memory-flow-place-fill);
  --memory-flow-node-border: var(--memory-flow-place-border);
  --memory-flow-node-muted: color-mix(in srgb, #bbf7d0 78%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-organization) {
  --memory-flow-node-fill: var(--memory-flow-organization-fill);
  --memory-flow-node-border: var(--memory-flow-organization-border);
  --memory-flow-node-muted: color-mix(in srgb, #bfdbfe 80%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-project) {
  --memory-flow-node-fill: var(--memory-flow-project-fill);
  --memory-flow-node-border: var(--memory-flow-project-border);
  --memory-flow-node-muted: color-mix(in srgb, #ddd6fe 80%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-event) {
  --memory-flow-node-fill: var(--memory-flow-event-fill);
  --memory-flow-node-border: var(--memory-flow-event-border);
  --memory-flow-node-muted: color-mix(in srgb, #fecdd3 78%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-date) {
  --memory-flow-node-fill: var(--memory-flow-date-fill);
  --memory-flow-node-border: var(--memory-flow-date-border);
  --memory-flow-node-muted: color-mix(in srgb, #fef08a 76%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-technology) {
  --memory-flow-node-fill: var(--memory-flow-technology-fill);
  --memory-flow-node-border: var(--memory-flow-technology-border);
  --memory-flow-node-muted: color-mix(in srgb, #a5f3fc 78%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-product) {
  --memory-flow-node-fill: var(--memory-flow-product-fill);
  --memory-flow-node-border: var(--memory-flow-product-border);
  --memory-flow-node-muted: color-mix(in srgb, #fed7aa 78%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-artifact) {
  --memory-flow-node-fill: var(--memory-flow-artifact-fill);
  --memory-flow-node-border: var(--memory-flow-artifact-border);
  --memory-flow-node-muted: color-mix(in srgb, #fde68a 78%, var(--color-theme-300));
}

:deep(.entity-flow-node-type-concept) {
  --memory-flow-node-fill: var(--memory-flow-concept-fill);
  --memory-flow-node-border: var(--memory-flow-concept-border);
  --memory-flow-node-muted: color-mix(in srgb, #c7d2fe 80%, var(--color-theme-300));
}

:deep(.entity-flow-edge path) {
  stroke: var(--memory-flow-edge);
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
  color: var(--memory-flow-node-muted);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
}

:deep(.entity-handle) {
  width: 6px;
  height: 6px;
  border: 1px solid var(--color-theme-100);
  background: var(--memory-flow-bg);
}

:deep(.entity-handle-source) {
  background: var(--memory-flow-edge);
}

:deep(.entity-node-toolbar) {
  display: flex;
  gap: 4px;
  padding: 5px;
  border: 1px solid var(--memory-flow-node-border);
  border-radius: 8px;
  background: var(--memory-flow-node-fill);
  box-shadow: 0 12px 24px var(--memory-flow-shadow);
}

:deep(.entity-node-toolbar button) {
  display: grid;
  width: 28px;
  height: 26px;
  place-items: center;
  border-radius: 6px;
  color: var(--memory-flow-node-muted);
  transition: background-color 120ms ease, color 120ms ease;
}

:deep(.entity-node-toolbar button:hover) {
  background: color-mix(in srgb, var(--color-accent-500) 18%, transparent);
  color: var(--color-theme-100);
}

:deep(.entity-flow-edge .vue-flow__edge-textbg) {
  stroke: color-mix(in srgb, var(--color-accent-500) 35%, transparent);
  stroke-width: 1px;
}

:deep(.vue-flow__controls) {
  border-color: var(--color-theme-800);
  box-shadow: 0 10px 22px var(--memory-flow-shadow);
}

:deep(.vue-flow__controls-button) {
  background: color-mix(in srgb, var(--color-theme-900) 90%, transparent);
  border-color: var(--color-theme-800);
  color: var(--color-theme-300);
}

:deep(.vue-flow__controls-button:hover) {
  background: var(--color-theme-800);
  color: var(--color-theme-100);
}

:deep(.vue-flow__minimap) {
  background: color-mix(in srgb, var(--color-theme-900) 86%, transparent);
  border: 1px solid var(--color-theme-800);
}
</style>
