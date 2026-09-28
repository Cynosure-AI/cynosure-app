<script setup lang="ts">
import { computed, ref } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraphEvidence, KnowledgeSourceChunk } from "../../api/types";

const props = defineProps<{
  selectedGraphNodes: KnowledgeGraphNode[];
  selectedGraphEdge: KnowledgeGraphEdge | null;
  graphEdges: KnowledgeGraphEdge[];
}>();

const emit = defineEmits<{
  close: [];
  "explore-node": [node: KnowledgeGraphNode];
  "edit-node": [node: KnowledgeGraphNode];
  "delete-node": [node: KnowledgeGraphNode];
  "delete-nodes": [nodes: KnowledgeGraphNode[]];
  "edit-edge": [edge: KnowledgeGraphEdge];
  "delete-edge": [edge: KnowledgeGraphEdge];
}>();

const hydratedSourceChunks = ref<Record<string, KnowledgeSourceChunk>>({});
const loadingSourceChunkIds = ref<Set<string>>(new Set());
const selectedGraphNode = computed(() => props.selectedGraphNodes.length === 1 ? props.selectedGraphNodes[0] : null);
const selectedGraphNodeIsLiteral = computed(() => selectedGraphNode.value?.id.startsWith("literal:") === true);
const selectedNodeIds = computed(() => new Set(props.selectedGraphNodes.map((node) => node.id)));
const sidebarTitle = computed(() => {
  if (props.selectedGraphEdge) return formatRelation(props.selectedGraphEdge.relation);
  if (selectedGraphNode.value) return selectedGraphNode.value.name;
  return `${formatCount(props.selectedGraphNodes.length)} entities selected`;
});
const selectedMentionCount = computed(() => props.selectedGraphNodes.reduce((total, node) => total + node.mentionCount, 0));
const selectedSourceCount = computed(() => props.selectedGraphNodes.reduce((total, node) => total + node.sourceCount, 0));
const selectedNodeAliases = computed(() => selectedGraphNode.value?.aliases || []);
const selectedOrigins = computed(() => {
  const origins = new Map<string, KnowledgeGraphEvidence>();
  for (const node of props.selectedGraphNodes) {
    for (const origin of node.origins || []) {
      const key = `${origin.sourceKind}:${origin.sourceId}`;
      const existing = origins.get(key);
      if (existing) {
        existing.count += origin.count;
        existing.lastSeenAt = Math.max(existing.lastSeenAt, origin.lastSeenAt);
        const chunks = new Map(existing.chunks.map((chunk) => [chunk.textUnitId, chunk]));
        for (const chunk of origin.chunks) {
          const current = chunks.get(chunk.textUnitId);
          if (current) current.notes = Array.from(new Set([...current.notes, ...chunk.notes]));
          else chunks.set(chunk.textUnitId, { ...chunk, notes: [...chunk.notes] });
        }
        existing.chunks = [...chunks.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
      } else {
        origins.set(key, { ...origin, chunks: origin.chunks.map((chunk) => ({ ...chunk, notes: [...chunk.notes] })) });
      }
    }
  }
  return [...origins.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.count - a.count).slice(0, 8);
});
const selectedNodeRelationships = computed(() => props.graphEdges
  .filter((edge) => selectedNodeIds.value.has(edge.fromNodeId) || selectedNodeIds.value.has(edge.toNodeId))
  .sort((a, b) => `${a.fromName} ${a.toName}`.localeCompare(`${b.fromName} ${b.toName}`)));

function formatCount(value: number): string { return new Intl.NumberFormat().format(value); }
function formatRelation(relation: string): string { return relation.replace(/_/g, " "); }
function formatOriginKind(kind: string): string {
  if (kind === "memory") return "Memory";
  if (kind === "conversation") return "Chat";
  return kind.replace(/_/g, " ");
}
function importanceLabel(level: number): string { return ["temporary", "minor", "useful", "core"][level] ?? "minor"; }
function importanceName(level: number): string {
  return ["conversational", "mildly interesting", "useful durable fact", "core fact"][level] ?? "unknown";
}
function sourceChunkLabel(chunk: KnowledgeSourceChunk): string {
  const section = chunk.sectionPath || chunk.documentTitle;
  return `Chunk ${chunk.chunkIndex + 1}${section ? ` · ${section}` : ""}`;
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
    hydratedSourceChunks.value = { ...hydratedSourceChunks.value,
      [chunk.textUnitId]: { ...chunk, text: "Source chunk unavailable." } };
  } finally {
    const next = new Set(loadingSourceChunkIds.value);
    next.delete(chunk.textUnitId);
    loadingSourceChunkIds.value = next;
  }
}
function deleteSelectedNodes(): void {
  if (props.selectedGraphNodes.length === 1) emit("delete-node", props.selectedGraphNodes[0]);
  else emit("delete-nodes", props.selectedGraphNodes);
}
function clearSelection(): void { emit("close"); }
</script>

<template>
  <aside class="entity-node-sidebar">
    <header class="entity-node-sidebar-header">
      <div class="min-w-0">
        <h3 class="entity-node-sidebar-title">
          {{ sidebarTitle }}
        </h3>
        <div class="entity-node-sidebar-meta">
          <template v-if="selectedGraphEdge">
            <span>relationship</span>
            <span>{{ importanceName(selectedGraphEdge.importance) }}</span>
            <span>{{ formatCount(selectedGraphEdge.mentionCount) }} evidence</span>
          </template>
          <template v-else>
            <span>{{ selectedGraphNodeIsLiteral ? "fact value" : selectedGraphNode?.type || "selection" }}</span>
            <span v-if="selectedGraphNode">{{ importanceName(selectedGraphNode.importance) }}</span>
            <span>{{ formatCount(selectedMentionCount) }} mentions</span>
            <span>{{ formatCount(selectedSourceCount) }} sources</span>
          </template>
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

    <template v-if="selectedGraphEdge">
      <div class="entity-node-sidebar-actions">
        <button
          type="button"
          class="entity-node-sidebar-action"
          @click="emit('edit-edge', selectedGraphEdge!)"
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
          @click="emit('delete-edge', selectedGraphEdge!)"
        >
          <Icon
            icon="lucide:trash-2"
            class="h-4 w-4"
          />
          Delete
        </button>
      </div>

      <div class="entity-node-sidebar-divider" />

      <div class="entity-node-sidebar-section-header">
        <span>Relationship</span>
        <span
          class="entity-sidebar-importance"
          :class="`entity-sidebar-importance-${selectedGraphEdge.importance}`"
        >{{ importanceLabel(selectedGraphEdge.importance) }}</span>
      </div>

      <div class="entity-node-sidebar-list">
        <div class="entity-node-sidebar-relation">
          <div class="entity-node-sidebar-relation-path">
            <span>{{ selectedGraphEdge.fromName }}</span>
            <Icon
              icon="lucide:arrow-right"
              class="h-3 w-3 shrink-0 text-theme-600"
            />
            <span>{{ selectedGraphEdge.toName }}</span>
          </div>
          <div class="entity-node-sidebar-relation-detail">
            <span>{{ formatRelation(selectedGraphEdge.relation) }}</span>
            <span>{{ formatOriginKind(selectedGraphEdge.sourceKind) }}</span>
          </div>
          <p
            v-if="selectedGraphEdge.note"
            class="text-[11px] leading-4 text-theme-300"
          >
            {{ selectedGraphEdge.note }}
          </p>
        </div>
      </div>

      <div class="entity-node-sidebar-divider" />

      <div class="entity-node-sidebar-section-header">
        <span>Origin</span>
        <span>{{ formatCount(selectedGraphEdge.sourceIds?.length || 1) }}</span>
      </div>

      <div class="entity-node-sidebar-list">
        <div class="entity-node-sidebar-relation">
          <div class="entity-node-sidebar-relation-path">
            <Icon
              :icon="selectedGraphEdge.sourceKind === 'memory' ? 'lucide:file-text' : 'lucide:message-circle'"
              class="h-3 w-3 shrink-0 text-theme-600"
            />
            <span>{{ selectedGraphEdge.sourceChunk?.fileName || selectedGraphEdge.sourceId }}</span>
          </div>
          <div class="entity-node-sidebar-relation-detail">
            <span>{{ formatOriginKind(selectedGraphEdge.sourceKind) }}</span>
            <span>{{ formatCount(selectedGraphEdge.mentionCount) }} evidence</span>
          </div>
          <details
            v-if="selectedGraphEdge.sourceChunk"
            class="mt-1 rounded-md border border-theme-800 bg-theme-950/70 p-2"
            @toggle="hydrateSourceChunk(selectedGraphEdge.sourceChunk, $event)"
          >
            <summary class="cursor-pointer list-none text-[10px] font-medium text-accent-fg hover:text-accent-fg">
              {{ sourceChunkLabel(selectedGraphEdge.sourceChunk) }}
            </summary>
            <div class="mt-2 whitespace-pre-wrap break-words border-l border-theme-700 pl-2 text-[10px] leading-4 text-theme-500">
              {{ sourceChunkLoading(selectedGraphEdge.sourceChunk) ? "Loading source chunk…" : sourceChunkText(selectedGraphEdge.sourceChunk) }}
            </div>
          </details>
        </div>
      </div>
    </template>

    <template v-else>
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
          v-if="selectedGraphNode && !selectedGraphNodeIsLiteral"
          type="button"
          class="entity-node-sidebar-action"
          title="Show this entity's connected neighborhood"
          @click="emit('explore-node', selectedGraphNode!)"
        >
          <Icon
            icon="lucide:unfold-vertical"
            class="h-4 w-4"
          />
          Explore
        </button>
        <button
          v-if="selectedGraphNode && !selectedGraphNodeIsLiteral"
          type="button"
          class="entity-node-sidebar-action"
          @click="emit('edit-node', selectedGraphNode!)"
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
          {{ selectedGraphNodes.length > 1 ? `Delete ${selectedGraphNodes.length}` : selectedGraphNodeIsLiteral ? "Delete fact" : "Delete" }}
        </button>
      </div>

      <div class="entity-node-sidebar-divider" />

      <div class="entity-node-sidebar-section-header">
        <span>Origins</span>
        <span>{{ formatCount(selectedOrigins.length) }}</span>
      </div>

      <div
        v-if="selectedOrigins.length"
        class="entity-node-sidebar-list"
      >
        <div
          v-for="origin in selectedOrigins"
          :key="`${origin.sourceKind}:${origin.sourceId}`"
          class="entity-node-sidebar-relation"
        >
          <div class="entity-node-sidebar-relation-path">
            <Icon
              :icon="origin.sourceKind === 'memory' ? 'lucide:file-text' : 'lucide:message-circle'"
              class="h-3 w-3 shrink-0 text-theme-600"
            />
            <span>{{ origin.label }}</span>
          </div>
          <div class="entity-node-sidebar-relation-detail">
            <span>{{ formatOriginKind(origin.sourceKind) }}</span>
            <span>{{ formatCount(origin.count) }} mentions</span>
          </div>
          <div
            v-for="chunk in origin.chunks"
            :key="chunk.textUnitId"
            class="mt-2 rounded-md border border-theme-800 bg-theme-950/70 p-2"
          >
            <p
              v-for="note in chunk.notes"
              :key="note"
              class="mb-1.5 text-[11px] leading-4 text-theme-300 last:mb-0"
            >
              {{ note }}
            </p>
            <details
              class="group/source mt-1"
              @toggle="hydrateSourceChunk(chunk, $event)"
            >
              <summary class="cursor-pointer list-none text-[10px] font-medium text-accent-fg hover:text-accent-fg">
                {{ sourceChunkLabel(chunk) }}
              </summary>
              <div class="mt-2 whitespace-pre-wrap break-words border-l border-theme-700 pl-2 text-[10px] leading-4 text-theme-500">
                {{ sourceChunkLoading(chunk) ? "Loading source chunk…" : sourceChunkText(chunk) }}
              </div>
            </details>
          </div>
        </div>
      </div>

      <div
        v-else
        class="entity-node-sidebar-empty"
      >
        No origin data for this selection.
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
            <span
              class="entity-sidebar-importance"
              :class="`entity-sidebar-importance-${edge.importance}`"
              :title="importanceName(edge.importance)"
            >{{ importanceLabel(edge.importance) }}</span>
          </div>
          <p
            v-if="edge.note"
            class="mt-1.5 text-[11px] leading-4 text-theme-300"
          >
            {{ edge.note }}
          </p>
          <details
            v-if="edge.sourceChunk"
            class="mt-2 rounded-md border border-theme-800 bg-theme-950/70 p-2"
            @toggle="hydrateSourceChunk(edge.sourceChunk, $event)"
          >
            <summary class="cursor-pointer list-none text-[10px] font-medium text-accent-fg hover:text-accent-fg">
              {{ sourceChunkLabel(edge.sourceChunk) }}
            </summary>
            <div class="mt-2 whitespace-pre-wrap break-words border-l border-theme-700 pl-2 text-[10px] leading-4 text-theme-500">
              {{ sourceChunkLoading(edge.sourceChunk) ? "Loading source chunk…" : sourceChunkText(edge.sourceChunk) }}
            </div>
          </details>
        </div>
      </div>

      <div
        v-else
        class="entity-node-sidebar-empty"
      >
        No relationships for this entity.
      </div>
    </template>
  </aside>
</template>
