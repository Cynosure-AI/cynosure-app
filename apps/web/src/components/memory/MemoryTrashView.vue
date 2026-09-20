<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { MemoryDiffSegment, MemoryRevisionSummary } from "../../api/types";
import ModalDialog from "../shared/ModalDialog.vue";
import MemoryInlineDiff from "./MemoryInlineDiff.vue";

type DeletedMemory = { documentRef: string; folderId: string; fileName: string; revision: string; deletedAt: number };

const emit = defineEmits<{ restored: [] }>();
const memories = ref<DeletedMemory[]>([]);
const loading = ref(false);
const error = ref("");
const restoringDocumentRef = ref("");
const historyRef = ref("");
const revisions = ref<MemoryRevisionSummary[]>([]);
const selectedRevisionId = ref("");
const revisionDiff = ref<MemoryDiffSegment[]>([]);
const showEmptyConfirmation = ref(false);
const emptying = ref(false);

async function loadTrash(): Promise<void> {
  historyRef.value = "";
  loading.value = true;
  error.value = "";
  try {
    memories.value = await api.memoryFolders.listDeleted();
  } catch (cause) {
    error.value = (cause as Error).message || "Failed to load deleted memories";
  } finally {
    loading.value = false;
  }
}

async function openHistory(memory: DeletedMemory): Promise<void> {
  historyRef.value = memory.documentRef;
  selectedRevisionId.value = "";
  revisionDiff.value = [];
  loading.value = true;
  try {
    revisions.value = await api.memoryFolders.listRevisions(memory.documentRef);
    if (revisions.value[0]) await selectRevision(revisions.value[0].id);
  } catch (cause) {
    error.value = (cause as Error).message || "Failed to load revision history";
  } finally {
    loading.value = false;
  }
}

async function selectRevision(revisionId: string): Promise<void> {
  selectedRevisionId.value = revisionId;
  const index = revisions.value.findIndex(revision => revision.id === revisionId);
  const selected = revisions.value[index];
  const previous = revisions.value[index + 1];
  if (!selected) return;
  if (previous) {
    revisionDiff.value = (await api.memoryFolders.getRevisionDiff(historyRef.value, previous.id, selected.id)).segments;
  } else {
    const revision = await api.memoryFolders.getRevision(historyRef.value, selected.id);
    revisionDiff.value = revision.content ? [{ type: "added", text: revision.content }] : [];
  }
}

async function restore(memory: DeletedMemory): Promise<void> {
  restoringDocumentRef.value = memory.documentRef;
  error.value = "";
  try {
    const available = historyRef.value === memory.documentRef ? revisions.value : await api.memoryFolders.listRevisions(memory.documentRef);
    const selected = available.find(revision => revision.id === selectedRevisionId.value) || available[0];
    if (!selected) throw new Error("This memory has no restorable revision.");
    await api.memoryFolders.restoreRevision(memory.documentRef, selected.id, "");
    memories.value = memories.value.filter(item => item.documentRef !== memory.documentRef);
    historyRef.value = "";
    emit("restored");
  } catch (cause) {
    error.value = (cause as Error).message || "Failed to restore memory";
  } finally {
    restoringDocumentRef.value = "";
  }
}

async function emptyTrash(): Promise<void> {
  emptying.value = true;
  error.value = "";
  try {
    await api.memoryFolders.emptyTrash();
    memories.value = [];
    historyRef.value = "";
    revisions.value = [];
    revisionDiff.value = [];
    showEmptyConfirmation.value = false;
  } catch (cause) {
    error.value = (cause as Error).message || "Failed to empty trash";
  } finally {
    emptying.value = false;
  }
}

onMounted(loadTrash);
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-red-500/20 bg-theme-950/45">
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-theme-800 bg-theme-900/50 px-4 py-3">
      <div>
        <h2 class="text-sm font-semibold text-red-300">
          Deleted Memories
        </h2>
        <p class="mt-0.5 text-xs text-theme-500">
          Review, restore, or permanently remove deleted documents.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="memories.length > 0"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-red-500/25 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10"
          @click="showEmptyConfirmation = true"
        >
          <Icon
            icon="lucide:trash-2"
            class="h-3.5 w-3.5"
          />
          Empty trash
        </button>
        <button
          type="button"
          class="rounded-lg p-2 text-theme-400 transition hover:bg-theme-800 hover:text-theme-100"
          title="Refresh deleted memories"
          @click="loadTrash"
        >
          <Icon
            icon="lucide:refresh-cw"
            class="h-4 w-4"
            :class="{ 'animate-spin': loading }"
          />
        </button>
      </div>
    </header>
    <div class="space-y-3 p-4 sm:p-5">
      <p
        v-if="error"
        class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300"
      >
        {{ error }}
      </p>
      <div
        v-if="loading"
        class="flex items-center gap-2 py-6 text-theme-500"
      >
        <Icon
          icon="lucide:loader-2"
          class="h-4 w-4 animate-spin"
        /> Loading deleted memories…
      </div>
      <p
        v-else-if="memories.length === 0"
        class="py-6 text-sm text-theme-500"
      >
        No deleted memories.
      </p>
      <template v-else-if="historyRef">
        <button
          class="inline-flex items-center gap-1 text-xs text-theme-400 hover:text-theme-200"
          @click="historyRef = ''"
        >
          <Icon
            icon="lucide:arrow-left"
            class="h-3.5 w-3.5"
          /> All deleted memories
        </button>
        <div class="grid gap-3 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div class="space-y-1">
            <button
              v-for="revision in revisions"
              :key="revision.id"
              class="w-full rounded-lg border px-3 py-2 text-left text-xs"
              :class="selectedRevisionId === revision.id ? 'border-accent-500 bg-accent-500/10 text-theme-100' : 'border-theme-800 text-theme-400'"
              @click="selectRevision(revision.id)"
            >
              <div>Revision {{ revision.revisionNumber }} · {{ revision.source }}</div>
              <div class="mt-1 text-theme-600">
                {{ new Date(revision.createdAt).toLocaleString() }}
              </div>
            </button>
          </div>
          <MemoryInlineDiff
            :segments="revisionDiff"
            class="max-h-[32rem]"
          />
        </div>
        <button
          class="rounded-lg bg-accent-600 px-3 py-2 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-50"
          :disabled="!selectedRevisionId || Boolean(restoringDocumentRef)"
          @click="restore(memories.find(item => item.documentRef === historyRef)!)"
        >
          Restore selected revision
        </button>
      </template>
      <div
        v-for="memory in (historyRef ? [] : memories)"
        :key="memory.documentRef"
        class="flex flex-col gap-3 rounded-lg border border-theme-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="min-w-0">
          <div class="truncate text-sm font-medium text-theme-200">
            {{ memory.fileName }}
          </div>
          <div class="mt-0.5 text-xs text-theme-500">
            Deleted {{ new Date(memory.deletedAt).toLocaleString() }}
          </div>
        </div>
        <div class="flex shrink-0 gap-2">
          <button
            class="rounded-lg border border-theme-700 px-3 py-1.5 text-xs text-theme-300 hover:bg-theme-800"
            @click="openHistory(memory)"
          >
            History
          </button>
          <button
            :disabled="restoringDocumentRef === memory.documentRef"
            class="rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50"
            @click="restore(memory)"
          >
            {{ restoringDocumentRef === memory.documentRef ? "Restoring…" : "Restore" }}
          </button>
        </div>
      </div>
    </div>
  </section>

  <ModalDialog
    :show="showEmptyConfirmation"
    title="Empty memory trash?"
    icon="lucide:trash-2"
    icon-color="red"
    @close="showEmptyConfirmation = false"
  >
    <p class="leading-relaxed text-theme-400">
      Permanently delete all {{ memories.length }} trashed document{{ memories.length === 1 ? "" : "s" }} and their revision history? This cannot be undone.
    </p>
    <template #actions>
      <button
        class="w-full rounded-xl bg-red-600 px-4 py-3 font-medium text-white hover:bg-red-500 disabled:opacity-50"
        :disabled="emptying"
        @click="emptyTrash"
      >
        {{ emptying ? "Emptying…" : "Empty trash permanently" }}
      </button>
      <button
        class="w-full rounded-xl bg-theme-800 px-4 py-3 font-medium text-theme-300 hover:bg-theme-700"
        :disabled="emptying"
        @click="showEmptyConfirmation = false"
      >
        Cancel
      </button>
    </template>
  </ModalDialog>
</template>
