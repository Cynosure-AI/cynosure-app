<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { MemoryIndexJob } from "../../api/types";
import type { UploadResult } from "./memory-file-explorer-types";

defineProps<{
  description?: string;
  searchLoading: boolean;
  uploading: boolean;
  uploadProgress: { current: number; total: number };
  uploadResults: UploadResult[];
  failedJobs: MemoryIndexJob[];
}>();

const query = defineModel<string>("query", { required: true });
const semantic = defineModel<boolean>("semantic", { required: true });

const emit = defineEmits<{
  searchInput: [];
  clearUploads: [];
  dismissFailure: [jobId: string];
  dismissAllFailures: [];
}>();

function jobKindLabel(kind: MemoryIndexJob["kind"]): string {
  if (kind === "deep-research") return "Deep Research";
  if (kind === "tool-embeddings") return "Tool indexing";
  return "Search indexing";
}
</script>

<template>
  <p
    v-if="description"
    class="mb-3 text-sm text-ink-muted"
  >
    {{ description }}
  </p>
  <div
    id="memory-document-search"
    class="mb-3 rounded-lg border border-theme-700/70 bg-control-surface p-2"
  >
    <div class="flex min-w-0 items-center gap-2">
      <div class="relative min-w-0 flex-1">
        <Icon
          icon="lucide:search"
          class="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted"
        />
        <input
          v-model="query"
          type="text"
          placeholder="Search this folder and subfolders…"
          class="w-full rounded-lg border border-theme-700/70 bg-control-surface py-2 pl-9 pr-14 text-sm text-theme-200 placeholder:text-ink-muted transition-colors focus:border-accent-500 focus:outline-none"
          @input="emit('searchInput')"
        >
        <Icon
          v-if="searchLoading"
          icon="lucide:loader-2"
          class="absolute right-9 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-ink-muted"
        />
        <button
          v-if="query"
          type="button"
          class="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200"
          title="Clear search"
          aria-label="Clear document search"
          @click="query = ''"
        >
          <Icon
            icon="lucide:x"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
      <button
        type="button"
        :aria-pressed="semantic"
        aria-label="Toggle semantic search"
        class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors"
        :class="semantic ? 'border-accent-500/50 bg-accent-500/15 text-accent-fg' : 'border-theme-700/70 bg-control-surface text-ink-muted hover:bg-table-hover hover:text-theme-200'"
        :title="semantic ? 'Semantic search is on' : 'Search document vectors by meaning'"
        @click="semantic = !semantic"
      >
        <Icon
          icon="lucide:sparkles"
          class="h-3.5 w-3.5"
        />
        <span class="hidden sm:inline">Semantic</span>
      </button>
    </div>
  </div>

  <div
    v-if="uploading"
    class="mb-4 rounded-lg border border-accent-500/20 bg-accent-500/10 px-3 py-2 text-xs text-accent-fg"
  >
    Uploading {{ uploadProgress.current }}/{{ uploadProgress.total }}…
  </div>

  <div
    v-if="uploadResults.length > 0"
    class="mb-4 space-y-1"
  >
    <div
      v-for="(result, index) in uploadResults"
      :key="index"
      class="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs"
      :class="result.error ? 'bg-status-danger/10 text-status-danger' : 'bg-status-success/10 text-status-success'"
    >
      <Icon
        :icon="result.error ? 'lucide:x-circle' : 'lucide:check-circle'"
        class="h-3.5 w-3.5"
      />
      <span class="truncate">{{ result.fileName }}</span>
      <span
        v-if="!result.error"
        class="text-ink-muted"
      >Uploaded — indexing is manual</span>
      <span
        v-else
        class="text-status-danger"
      >{{ result.error }}</span>
    </div>
    <button
      class="px-1 text-xs text-ink-muted hover:text-theme-300"
      @click="emit('clearUploads')"
    >
      Clear
    </button>
  </div>

  <div
    v-if="failedJobs.length > 0"
    class="mb-4 space-y-1"
  >
    <div
      v-for="job in failedJobs"
      :key="job.id"
      class="flex items-start gap-2 rounded-lg border border-status-danger/20 bg-status-danger/10 px-3 py-2 text-xs text-status-danger"
    >
      <Icon
        icon="lucide:circle-alert"
        class="mt-0.5 h-3.5 w-3.5 shrink-0"
      />
      <div class="min-w-0 flex-1">
        <div class="font-medium">
          {{ jobKindLabel(job.kind) }} failed for {{ job.fileName }}
        </div>
        <div class="mt-0.5 break-words text-status-danger/80">
          {{ job.error || "Unknown error" }}
        </div>
      </div>
      <button
        type="button"
        class="shrink-0 rounded px-1.5 py-0.5 text-status-danger transition-colors hover:bg-red-500/10 hover:text-red-200"
        title="Dismiss"
        aria-label="Dismiss failure"
        @click="emit('dismissFailure', job.id)"
      >
        <Icon
          icon="lucide:x"
          class="h-3.5 w-3.5"
        />
      </button>
    </div>
    <button
      v-if="failedJobs.length > 1"
      type="button"
      class="px-1 text-xs text-ink-muted transition-colors hover:text-theme-300"
      @click="emit('dismissAllFailures')"
    >
      Clear all
    </button>
  </div>
</template>
