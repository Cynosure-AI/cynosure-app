<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Icon } from "@iconify/vue";
import type { EntityGraphEdge, EntityGraphNode, EntityGraphResponse } from "../../api/types";
import DataTable, { type Column } from "../shared/DataTable.vue";
import EntityGraphSearchBox from "./EntityGraphSearchBox.vue";

const props = defineProps<{
  graph: EntityGraphResponse | null;
  graphLoading: boolean;
  graphQuery: string;
  graphSuggestions: EntityGraphNode[];
}>();

const emit = defineEmits<{
  "update:graphQuery": [value: string];
  "load-graph": [query?: string];
  "clear-walk": [];
  "select-suggestion": [node: EntityGraphNode];
  "edit-edge": [edge: EntityGraphEdge];
  "delete-edge": [edge: EntityGraphEdge];
  "delete-edges": [ids: string[]];
}>();

const PAGE_SIZE = 30;
const selectedIds = ref<string[]>([]);
const currentPage = ref(1);

const columns: Column<EntityGraphEdge>[] = [
  { key: "fromName", label: "From", width: "minmax(0, 1.5fr)", sortable: true },
  { key: "relation", label: "Relation", width: "minmax(0, 1.5fr)", sortable: true, sortValue: (e) => e.relation },
  { key: "toName", label: "To", width: "minmax(0, 1.5fr)", sortable: true },
  { key: "importance", label: "Importance", width: "120px", sortable: true, sortValue: (e) => e.importance },
  { key: "lastSeenAt", label: "Last Seen", width: "140px", sortable: true },
  { key: "actions", label: "", width: "80px" },
];

function formatRelation(relation: string): string {
  return relation.replace(/_/g, " ");
}

function importanceLabel(level: number): string {
  return ["temporary", "minor", "useful", "core"][level] ?? "minor";
}

function importanceName(level: number): string {
  return ["conversational", "mildly interesting", "useful durable fact", "core fact"][level] ?? "unknown";
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

function edgeMatchesQuery(edge: EntityGraphEdge, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return [
    edge.fromName,
    edge.relation,
    edge.toName,
    edge.evidence || "",
  ].some((value) => value.toLowerCase().includes(trimmed));
}

const filteredEdges = computed(() =>
  (props.graph?.edges || []).filter((edge) => edgeMatchesQuery(edge, props.graphQuery)),
);

const pageCount = computed(() => Math.max(1, Math.ceil(filteredEdges.value.length / PAGE_SIZE)));

const pagedEdges = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE;
  return filteredEdges.value.slice(start, start + PAGE_SIZE);
});

const pageStart = computed(() => filteredEdges.value.length ? (currentPage.value - 1) * PAGE_SIZE + 1 : 0);
const pageEnd = computed(() => Math.min(currentPage.value * PAGE_SIZE, filteredEdges.value.length));

const selectedPageCount = computed(() =>
  pagedEdges.value.filter((edge) => selectedIds.value.includes(edge.id)).length,
);

const selectedFilteredCount = computed(() =>
  filteredEdges.value.filter((edge) => selectedIds.value.includes(edge.id)).length,
);

watch(() => props.graphQuery, () => {
  currentPage.value = 1;
});

watch(filteredEdges, () => {
  if (currentPage.value > pageCount.value) currentPage.value = pageCount.value;
});

function mergeSelection(ids: string[]) {
  selectedIds.value = Array.from(new Set([...selectedIds.value, ...ids]));
}

function selectPage() {
  mergeSelection(pagedEdges.value.map((edge) => edge.id));
}

function selectAllFiltered() {
  mergeSelection(filteredEdges.value.map((edge) => edge.id));
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
        class="flex items-start gap-2"
        @submit.prevent="emit('load-graph', graphQuery)"
      >
        <EntityGraphSearchBox
          :model-value="graphQuery"
          :suggestions="graphSuggestions"
          placeholder="Search relationships"
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
        class="mb-3 flex flex-col gap-2 rounded-lg border border-theme-700 bg-theme-900 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex flex-wrap items-center gap-2 text-sm text-theme-300">
          <span>{{ selectedIds.length }} selected</span>
          <span class="text-xs text-theme-600">
            Showing {{ pageStart }}-{{ pageEnd }} of {{ filteredEdges.length }}
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-theme-700 px-3 py-1 text-xs text-theme-300 hover:bg-theme-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="pagedEdges.length === 0 || selectedPageCount === pagedEdges.length"
            @click="selectPage"
          >
            <Icon
              icon="lucide:file-text"
              class="w-3.5 h-3.5"
            />
            Select Page
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-theme-700 px-3 py-1 text-xs text-theme-300 hover:bg-theme-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="filteredEdges.length === 0 || selectedFilteredCount === filteredEdges.length"
            @click="selectAllFiltered"
          >
            <Icon
              icon="lucide:list-checks"
              class="w-3.5 h-3.5"
            />
            Select All
          </button>
          <button
            v-if="selectedIds.length"
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
            v-if="selectedIds.length"
            type="button"
            class="text-xs text-theme-500 hover:text-theme-300 transition-colors"
            @click="selectedIds = []"
          >
            Clear selection
          </button>
        </div>
      </div>

      <DataTable
        v-model:selected-ids="selectedIds"
        :items="pagedEdges"
        :columns="columns"
        :selectable="true"
        initial-sort-key="lastSeenAt"
        initial-sort-direction="desc"
        :empty-message="graphQuery.trim() ? 'No relationships match this search.' : 'No relationships have been extracted yet.'"
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

        <template #col-importance="{ item }">
          <span
            class="inline-block rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            :class="{
              'bg-theme-800 text-theme-400': item.importance === 0,
              'bg-theme-700/50 text-theme-300': item.importance === 1,
              'bg-green-900/30 text-green-400': item.importance === 2,
              'bg-accent-900/30 text-accent-300': item.importance === 3,
            }"
            :title="importanceName(item.importance)"
          >{{ importanceLabel(item.importance) }}</span>
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

      <div
        v-if="filteredEdges.length > PAGE_SIZE"
        class="mt-4 flex flex-col gap-2 text-sm text-theme-400 sm:flex-row sm:items-center sm:justify-between"
      >
        <span>Page {{ currentPage }} of {{ pageCount }}</span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-theme-700 px-3 py-1.5 text-xs text-theme-300 hover:bg-theme-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="currentPage <= 1"
            @click="currentPage--"
          >
            <Icon
              icon="lucide:chevron-left"
              class="w-3.5 h-3.5"
            />
            Previous
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-theme-700 px-3 py-1.5 text-xs text-theme-300 hover:bg-theme-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="currentPage >= pageCount"
            @click="currentPage++"
          >
            Next
            <Icon
              icon="lucide:chevron-right"
              class="w-3.5 h-3.5"
            />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
