<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { EntityGraphEdge, EntityGraphResponse } from "../../api/types";

defineProps<{
  graph: EntityGraphResponse | null;
  graphLoading: boolean;
  graphQuery: string;
}>();

const emit = defineEmits<{
  "update:graphQuery": [value: string];
  "load-graph": [query?: string];
  "clear-walk": [];
  "edit-edge": [edge: EntityGraphEdge];
  "delete-edge": [edge: EntityGraphEdge];
}>();

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
        class="flex items-center gap-2"
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
            placeholder="Walk from Tom, Acme, Project X"
            @input="emit('update:graphQuery', ($event.target as HTMLInputElement).value)"
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
          @click="emit('clear-walk')"
        >
          <Icon
            icon="lucide:x"
            class="w-4 h-4"
          />
        </button>
      </form>
    </div>

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
              @click="emit('edit-edge', edge)"
            >
              <Icon
                icon="lucide:pencil"
                class="w-3.5 h-3.5"
              />
            </button>
            <button
              class="p-1 text-theme-600 hover:text-red-400 transition-colors"
              title="Delete relationship"
              @click="emit('delete-edge', edge)"
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
</template>
