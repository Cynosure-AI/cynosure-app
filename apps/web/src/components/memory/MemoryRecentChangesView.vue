<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { RecentMemoryChange } from "../../api/types";
import MemoryInlineDiff from "./MemoryInlineDiff.vue";

const changes = ref<RecentMemoryChange[]>([]);
const loading = ref(false);
const error = ref("");

function sourceLabel(source: RecentMemoryChange["source"]): string {
  if (source === "ai") return "Model";
  if (source === "dream") return "Dream";
  if (source === "user") return "User";
  if (source === "filesystem") return "File system";
  if (source === "restore") return "Restore";
  return "Import";
}

function sourceClass(source: RecentMemoryChange["source"]): string {
  if (source === "dream") return "bg-amber-200/10 text-amber-200 ring-amber-200/20";
  if (source === "ai") return "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20";
  if (source === "filesystem") return "bg-green-500/10 text-green-300 ring-green-500/20";
  if (source === "user") return "bg-sky-500/10 text-sky-300 ring-sky-500/20";
  if (source === "restore") return "bg-cyan-500/10 text-cyan-300 ring-cyan-500/20";
  return "bg-violet-500/10 text-violet-300 ring-violet-500/20";
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    changes.value = await api.memoryFolders.listRecentChanges();
  } catch (cause) {
    error.value = (cause as Error).message || "Failed to load recent memory changes";
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-theme-800 bg-theme-950/45">
    <header class="flex items-center justify-between gap-3 border-b border-theme-800 bg-theme-900/50 px-4 py-3">
      <div>
        <h2 class="text-sm font-semibold text-theme-100">
          Recent Memory Changes
        </h2>
        <p class="mt-0.5 text-xs text-theme-500">
          A timeline of changes across all memory folders.
        </p>
      </div>
      <button
        type="button"
        class="rounded-lg p-2 text-theme-400 transition hover:bg-theme-800 hover:text-theme-100"
        title="Refresh recent changes"
        @click="load"
      >
        <Icon
          icon="lucide:refresh-cw"
          class="h-4 w-4"
          :class="{ 'animate-spin': loading }"
        />
      </button>
    </header>
    <div class="p-4 sm:p-5">
      <p
        v-if="error"
        class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300"
      >
        {{ error }}
      </p>
      <div
        v-if="loading"
        class="flex items-center gap-2 py-8 text-theme-500"
      >
        <Icon
          icon="lucide:loader-2"
          class="h-4 w-4 animate-spin"
        /> Loading recent changes…
      </div>
      <p
        v-else-if="changes.length === 0"
        class="py-8 text-sm text-theme-500"
      >
        No memory changes have been recorded yet.
      </p>
      <ol
        v-else
        class="space-y-4"
      >
        <li
          v-for="change in changes"
          :key="change.id"
          class="relative pl-7 before:absolute before:bottom-[-1rem] before:left-[9px] before:top-5 before:w-px before:bg-theme-800 last:before:hidden"
        >
          <span class="absolute left-0 top-2 h-[19px] w-[19px] rounded-full border-4 border-theme-950 bg-accent-500" />
          <article class="overflow-hidden rounded-xl border border-theme-800 bg-theme-900/35">
            <header class="flex flex-wrap items-start justify-between gap-2 border-b border-theme-800 px-4 py-3">
              <div class="min-w-0">
                <h3 class="truncate text-sm font-medium text-theme-100">
                  {{ change.fileName }}
                </h3>
                <p class="mt-0.5 text-xs text-theme-500">
                  {{ new Date(change.createdAt).toLocaleString() }} · Revision {{ change.revisionNumber }}
                </p>
              </div>
              <div class="flex items-center gap-1.5">
                <span
                  v-if="change.status === 'deleted'"
                  class="rounded-full bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-300"
                >Deleted</span>
                <span
                  class="rounded-full px-2 py-1 text-[10px] font-medium ring-1 ring-inset"
                  :class="sourceClass(change.source)"
                >{{ sourceLabel(change.source) }}</span>
              </div>
            </header>
            <MemoryInlineDiff
              :segments="change.segments"
              class="max-h-64 rounded-none border-0"
            />
          </article>
        </li>
      </ol>
    </div>
  </section>
</template>
