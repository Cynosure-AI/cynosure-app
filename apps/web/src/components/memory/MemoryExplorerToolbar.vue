<script setup lang="ts">
import { Icon } from "@iconify/vue";

defineProps<{
  searching: boolean;
  resultCount: number;
  folderName?: string;
  folderCount: number;
  fileCount: number;
  runningJobCount: number;
  selectedCount: number;
  rowCount: number;
  filteredFileCount: number;
  allSelected: boolean;
  spaceCount: number;
  selectedFolderCount: number;
  canIndex: boolean;
  indexIdleCount: number;
  canResearch: boolean;
  researchIdleCount: number;
  canForget: boolean;
  moving: boolean;
  forgetting: boolean;
  deleting: boolean;
  filesLoading: boolean;
}>();

const view = defineModel<"list" | "grid">("view", { required: true });

const emit = defineEmits<{
  selectPage: [];
  selectAll: [];
  move: [];
  index: [];
  research: [];
  forget: [];
  remove: [];
  clearSelection: [];
  refresh: [];
}>();
</script>

<template>
  <div class="mb-2 flex items-center justify-between">
    <div class="text-xs text-theme-500">
      <template v-if="searching">
        {{ resultCount }} result{{ resultCount !== 1 ? "s" : "" }} in {{ folderName || "this folder" }} and subfolders
      </template>
      <template v-else>
        {{ folderCount }} folder{{ folderCount !== 1 ? "s" : "" }} · {{ fileCount }} file{{ fileCount !== 1 ? "s" : "" }}
      </template>
      <template v-if="runningJobCount > 0">
        · {{ runningJobCount }} job{{ runningJobCount !== 1 ? "s" : "" }} active
      </template>
    </div>
    <div class="flex items-center gap-2">
      <template v-if="!searching && selectedCount === 0 && rowCount > 0">
        <button
          class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200"
          @click="emit('selectPage')"
        >
          Select page
        </button>
        <button
          class="px-2 py-1 text-xs text-theme-400 hover:text-theme-200"
          @click="emit('selectAll')"
        >
          Select all {{ filteredFileCount }}
        </button>
      </template>
      <div
        v-if="!searching"
        class="flex items-center rounded-lg border border-theme-800 bg-theme-900/60 p-0.5"
        aria-label="Explorer view"
      >
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          :class="view === 'list' ? 'bg-theme-700 text-theme-100' : 'text-theme-500 hover:text-theme-200'"
          title="List view"
          aria-label="List view"
          :aria-pressed="view === 'list'"
          @click="view = 'list'"
        >
          <Icon
            icon="lucide:list"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          :class="view === 'grid' ? 'bg-theme-700 text-theme-100' : 'text-theme-500 hover:text-theme-200'"
          title="Grid view"
          aria-label="Grid view"
          :aria-pressed="view === 'grid'"
          @click="view = 'grid'"
        >
          <Icon
            icon="lucide:grid-2x2"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
      <button
        type="button"
        :disabled="filesLoading"
        class="px-2 py-1.5 text-xs text-theme-400 hover:text-theme-200"
        aria-label="Refresh documents"
        @click="emit('refresh')"
      >
        <Icon
          :icon="filesLoading ? 'lucide:loader-2' : 'lucide:refresh-cw'"
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': filesLoading }"
        />
      </button>
    </div>
  </div>

  <div
    v-if="!searching && selectedCount > 0"
    class="pointer-events-none sticky top-[calc(100vh_-_8rem)] z-30 h-0 sm:top-[calc(100vh_-_5.5rem)]"
  >
    <div class="pointer-events-auto mx-auto flex w-fit max-w-full items-center overflow-x-auto rounded-xl border border-theme-700/80 bg-theme-950/95 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl">
      <span class="shrink-0 border-r border-theme-800 px-3 text-xs font-medium text-theme-300">{{ selectedCount }} selected</span>
      <button
        v-if="!allSelected"
        class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-theme-400 transition-colors hover:bg-theme-800 hover:text-theme-200"
        @click="emit('selectAll')"
      >
        Select all {{ rowCount }}
      </button>
      <button
        v-if="spaceCount > 1"
        :disabled="moving"
        class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-accent-400 transition-colors hover:bg-accent-500/10 disabled:opacity-50"
        @click="emit('move')"
      >
        <Icon
          :icon="moving ? 'lucide:loader-2' : 'lucide:folder-input'"
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': moving }"
        /> Move
      </button>
      <button
        v-if="canIndex || selectedFolderCount > 0"
        :disabled="selectedFolderCount === 0 && indexIdleCount === 0"
        class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-orange-400 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
        title="Build or refresh semantic search vectors for the selected documents"
        @click="emit('index')"
      >
        <Icon
          :icon="selectedFolderCount === 0 && indexIdleCount === 0 ? 'lucide:loader-2' : 'lucide:search-check'"
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': selectedFolderCount === 0 && indexIdleCount === 0 }"
        /> Index files
      </button>
      <button
        v-if="canResearch || selectedFolderCount > 0"
        :disabled="selectedFolderCount === 0 && researchIdleCount === 0"
        class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
        title="Extract and classify facts from the selected searchable documents"
        @click="emit('research')"
      >
        <Icon
          :icon="selectedFolderCount === 0 && researchIdleCount === 0 ? 'lucide:loader-2' : 'lucide:network'"
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': selectedFolderCount === 0 && researchIdleCount === 0 }"
        /> Deep Research
      </button>
      <button
        v-if="canForget || selectedFolderCount > 0"
        :disabled="forgetting"
        class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-orange-400 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
        title="Remove semantic search vectors and extracted facts while keeping the source files"
        @click="emit('forget')"
      >
        <Icon
          :icon="forgetting ? 'lucide:loader-2' : 'lucide:brain-circuit'"
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': forgetting }"
        /> Drop Index
      </button>
      <button
        :disabled="deleting"
        class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
        title="Remove the selected source files and their indexes"
        @click="emit('remove')"
      >
        <Icon
          :icon="deleting ? 'lucide:loader-2' : 'lucide:trash-2'"
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': deleting }"
        /> Remove
      </button>
      <button
        class="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-l border-theme-800 text-theme-500 transition-colors hover:bg-theme-800 hover:text-theme-200"
        title="Clear selection"
        aria-label="Clear selection"
        @click="emit('clearSelection')"
      >
        <Icon
          icon="lucide:x"
          class="h-4 w-4"
        />
      </button>
    </div>
  </div>
</template>
