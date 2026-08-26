<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraph, KnowledgeSourceChunk } from "../../api/types";
import DataTable, { type Column } from "../shared/DataTable.vue";
import KnowledgeGraphSearchBox from "./KnowledgeGraphSearchBox.vue";

const props = defineProps<{
  graph: KnowledgeGraph | null;
  graphLoading: boolean;
  graphQuery: string;
  graphSuggestions: KnowledgeGraphNode[];
  walkNodes: KnowledgeGraphNode[];
}>();

const emit = defineEmits<{
  "update:graphQuery": [value: string];
  "load-graph": [query?: string];
  "clear-walk": [];
  "select-suggestion": [node: KnowledgeGraphNode];
  "remove-selected-node": [nodeId: string];
  "edit-edge": [edge: KnowledgeGraphEdge];
  "delete-edge": [edge: KnowledgeGraphEdge];
  "delete-edges": [ids: string[]];
}>();

const PAGE_SIZE = 30;
const selectedIds = ref<string[]>([]);
const currentPage = ref(0);
const visibleEdges = ref<KnowledgeGraphEdge[]>([]);
const hydratedSourceChunks = ref<Record<string, KnowledgeSourceChunk>>({});
const loadingSourceChunkIds = ref<Set<string>>(new Set());

const columns: Column<KnowledgeGraphEdge>[] = [
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

function edgeMatchesQuery(edge: KnowledgeGraphEdge, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return [
    edge.fromName,
    edge.relation,
    edge.toName,
    edge.note || "",
    edge.sourceChunk?.text || "",
  ].some((value) => value.toLowerCase().includes(trimmed));
}

function sourceChunkText(chunk: KnowledgeSourceChunk): string {
  return hydratedSourceChunks.value[chunk.textUnitId]?.text || chunk.text;
}

function sourceChunkLoading(chunk: KnowledgeSourceChunk): boolean {
  return loadingSourceChunkIds.value.has(chunk.textUnitId);
}

async function hydrateSourceChunk(chunk: KnowledgeSourceChunk, event: Event): Promise<void> {
  if (!(event.currentTarget as HTMLDetailsElement).open) return;
  if (chunk.text || hydratedSourceChunks.value[chunk.textUnitId] || loadingSourceChunkIds.value.has(chunk.textUnitId)) return;

  loadingSourceChunkIds.value = new Set(loadingSourceChunkIds.value).add(chunk.textUnitId);
  try {
    const hydrated = await api.memory.getKnowledgeSourceChunk(chunk.textUnitId);
    hydratedSourceChunks.value = { ...hydratedSourceChunks.value, [chunk.textUnitId]: hydrated };
  } catch {
    hydratedSourceChunks.value = {
      ...hydratedSourceChunks.value,
      [chunk.textUnitId]: { ...chunk, text: "Source chunk unavailable." },
    };
  } finally {
    const next = new Set(loadingSourceChunkIds.value);
    next.delete(chunk.textUnitId);
    loadingSourceChunkIds.value = next;
  }
}

const filteredEdges = computed(() =>
  (props.graph?.edges || []).filter((edge) => edgeMatchesQuery(edge, props.graphQuery)),
);

const pageStart = computed(() => filteredEdges.value.length ? currentPage.value * PAGE_SIZE + 1 : 0);
const pageEnd = computed(() => Math.min((currentPage.value + 1) * PAGE_SIZE, filteredEdges.value.length));

const selectedPageCount = computed(() =>
  visibleEdges.value.filter((edge) => selectedIds.value.includes(edge.id)).length,
);

const selectedFilteredCount = computed(() =>
  filteredEdges.value.filter((edge) => selectedIds.value.includes(edge.id)).length,
);

watch(() => props.graphQuery, () => {
  currentPage.value = 0;
});

function mergeSelection(ids: string[]) {
  selectedIds.value = Array.from(new Set([...selectedIds.value, ...ids]));
}

function selectPage() {
  mergeSelection(visibleEdges.value.map((edge) => edge.id));
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
        <KnowledgeGraphSearchBox
          :model-value="graphQuery"
          :suggestions="graphSuggestions"
          :selected-node-ids="walkNodes.map((node) => node.id)"
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
          v-if="graphQuery.trim() || walkNodes.length"
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
        v-if="walkNodes.length"
        class="mb-4 flex flex-wrap gap-2"
      >
        <button
          v-for="node in walkNodes"
          :key="node.id"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-accent-500/30 bg-accent-500/10 px-2 py-1 text-xs text-accent-200"
          :title="`Remove ${node.name} from the graph walk`"
          @click="emit('remove-selected-node', node.id)"
        >
          <Icon
            icon="lucide:sparkles"
            class="w-3 h-3"
          />
          {{ node.name }}
          <span class="text-accent-300/70">{{ node.type }}</span>
          <Icon
            icon="lucide:x"
            class="h-3 w-3 text-accent-300/70"
          />
        </button>
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
            :disabled="visibleEdges.length === 0 || selectedPageCount === visibleEdges.length"
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
        v-model:page="currentPage"
        :items="filteredEdges"
        :columns="columns"
        :selectable="true"
        :pagination="true"
        :page-size="PAGE_SIZE"
        initial-sort-key="lastSeenAt"
        initial-sort-direction="desc"
        :empty-message="graphQuery.trim() ? 'No relationships match this search.' : 'No relationships have been extracted yet.'"
        @visible-items-change="visibleEdges = $event"
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
            v-if="item.note || item.sourceChunk"
            class="space-y-2 pl-19 pr-5 pb-3 text-xs leading-relaxed"
          >
            <p
              v-if="item.note"
              class="text-theme-300"
            >
              {{ item.note }}
            </p>
            <details
              v-if="item.sourceChunk"
              class="rounded-md border border-theme-800 bg-theme-950/60 p-2"
              @toggle="hydrateSourceChunk(item.sourceChunk, $event)"
            >
              <summary class="cursor-pointer text-[11px] font-medium text-accent-400">
                Source chunk {{ item.sourceChunk.chunkIndex + 1 }}
                <template v-if="item.sourceChunk.sectionPath || item.sourceChunk.documentTitle">
                  · {{ item.sourceChunk.sectionPath || item.sourceChunk.documentTitle }}
                </template>
              </summary>
              <div class="mt-2 whitespace-pre-wrap break-words border-l border-theme-700 pl-2 text-theme-500">
                {{ sourceChunkLoading(item.sourceChunk) ? "Loading source chunkâ€¦" : sourceChunkText(item.sourceChunk) }}
              </div>
            </details>
          </div>
        </template>
      </DataTable>
    </template>
  </div>
</template>
