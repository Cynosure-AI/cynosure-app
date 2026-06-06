<script setup lang="ts">
import { ref } from "vue";
import { Icon } from "@iconify/vue";
import type { EntityGraphEdge, EntityGraphResponse } from "../../api/types";
import DataTable, { type Column } from "../shared/DataTable.vue";

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
  "delete-edges": [ids: string[]];
}>();

const selectedIds = ref<string[]>([]);

const columns: Column<EntityGraphEdge>[] = [
  { key: "fromName", label: "From", width: "minmax(0, 1.5fr)", sortable: true },
  { key: "relation", label: "Relation", width: "minmax(0, 1.5fr)", sortable: true, sortValue: (e) => e.relation },
  { key: "toName", label: "To", width: "minmax(0, 1.5fr)", sortable: true },
  { key: "lastSeenAt", label: "Last Seen", width: "140px", sortable: true },
  { key: "actions", label: "", width: "80px" },
];

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

function handleBulkDelete() {
  emit("delete-edges", [...selectedIds.value]);
  selectedIds.value = [];
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

      <!-- Bulk action bar -->
      <div
        v-if="selectedIds.length"
        class="mb-3 flex items-center gap-3 rounded-lg border border-theme-700 bg-theme-900 px-4 py-2.5"
      >
        <span class="text-sm text-theme-300">{{ selectedIds.length }} selected</span>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md bg-red-600/20 px-3 py-1 text-xs text-red-400 hover:bg-red-600/30 transition-colors"
          @click="handleBulkDelete"
        >
          <Icon
            icon="lucide:trash-2"
            class="w-3.5 h-3.5"
          />
          Delete selected
        </button>
        <button
          type="button"
          class="text-xs text-theme-500 hover:text-theme-300 transition-colors"
          @click="selectedIds = []"
        >
          Clear selection
        </button>
      </div>

      <DataTable
        v-model:selected-ids="selectedIds"
        :items="graph.edges"
        :columns="columns"
        :selectable="true"
        initial-sort-key="lastSeenAt"
        initial-sort-direction="desc"
        empty-message="No relationships have been extracted yet."
      >
        <template #col-fromName="{ item }">
          <span class="font-medium text-theme-100">{{ item.fromName }}</span>
        </template>

        <template #col-relation="{ item }">
          <span class="rounded-md bg-theme-800 px-2 py-0.5 text-xs text-theme-300">{{ formatRelation(item.relation) }}</span>
        </template>

        <template #col-toName="{ item }">
          <span class="font-medium text-theme-100">{{ item.toName }}</span>
        </template>

        <template #col-lastSeenAt="{ item }">
          <span class="text-xs text-theme-500">{{ formatDate(item.lastSeenAt) }}</span>
        </template>

        <template #col-actions="{ item }">
          <div
            class="flex items-center gap-1"
            @click.stop
          >
            <button
              type="button"
              class="p-1 text-theme-600 hover:text-theme-200 transition-colors"
              title="Edit relationship"
              @click="emit('edit-edge', item)"
            >
              <Icon
                icon="lucide:pencil"
                class="w-3.5 h-3.5"
              />
            </button>
            <button
              type="button"
              class="p-1 text-theme-600 hover:text-red-400 transition-colors"
              title="Delete relationship"
              @click="emit('delete-edge', item)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-3.5 h-3.5"
              />
            </button>
          </div>
        </template>

        <template #row-expand="{ item }">
          <div
            v-if="item.evidence"
            class="pl-19 pr-5 pb-3 text-xs text-theme-500 leading-relaxed"
          >
            {{ item.evidence }}
          </div>
        </template>
      </DataTable>
    </template>
  </div>
</template>
