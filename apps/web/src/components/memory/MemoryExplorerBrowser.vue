<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { MemoryFileStatus, MemoryFolder } from "../../api/types";
import DataTable, { type Column } from "../shared/DataTable.vue";
import type { DocumentRow, ExplorerRow, GlobalDocumentRow } from "./memory-file-explorer-types";

defineProps<{
  searchQuery: string;
  searchLoading: boolean;
  searchRows: GlobalDocumentRow[];
  searchColumns: Column<GlobalDocumentRow>[];
  explorerView: "list" | "grid";
  files: MemoryFileStatus[];
  filesLoading: boolean;
  childFolders: MemoryFolder[];
  filteredFiles: MemoryFileStatus[];
  documentRows: ExplorerRow[];
  columns: Column<ExplorerRow>[];
  selectedFiles: Set<string>;
  selectedFolders: Set<string>;
  selectedItemCount: number;
  highlightedFolderId: string | null;
  dropTargetFolderId: string | null;
  isRowSelectable: (item: ExplorerRow) => boolean;
  sortGroup: (item: ExplorerRow) => number;
  rowForFolder: (folder: MemoryFolder) => ExplorerRow;
  rowForFile: (file: MemoryFileStatus) => DocumentRow;
  hasRecentDreamUpdate: (file: MemoryFileStatus) => boolean;
  statusIcon: (status: MemoryFileStatus["status"]) => string;
  statusLabel: (status: MemoryFileStatus["status"]) => string;
  folderIndexSummary: (folder: MemoryFolder) => { label: string; icon: string; colorClass: string; ratio: number };
  formatFileSize: (bytes: number) => string;
  isJobActive: (kind: "reindex" | "deep-research", fileName: string) => boolean;
  searchIndexProgress: (fileName: string) => string;
  deepResearchProgress: (fileName: string) => string;
}>();

const page = defineModel<number>("page", { required: true });
const selectedIds = defineModel<string[]>("selectedIds", { required: true });

const emit = defineEmits<{
  openGlobalResult: [file: GlobalDocumentRow];
  openFolder: [folder: MemoryFolder];
  openDocument: [fileName: string];
  openContextMenu: [kind: "folder" | "document", event: MouseEvent, item: MemoryFolder | MemoryFileStatus];
  toggleGridSelection: [item: ExplorerRow, event: MouseEvent];
  folderDragOver: [folder: MemoryFolder, event: DragEvent];
  folderDragLeave: [folder: MemoryFolder, event: DragEvent];
  folderDrop: [folder: MemoryFolder, event: DragEvent];
  documentDragStart: [event: DragEvent, fileName: string];
  documentDragEnd: [];
  rowClick: [item: ExplorerRow];
  rowContextMenu: [item: ExplorerRow, event: MouseEvent];
  rowDragStart: [item: ExplorerRow, event: DragEvent];
  rowDragOver: [item: ExplorerRow, event: DragEvent];
  rowDragLeave: [item: ExplorerRow, event: DragEvent];
  rowDrop: [item: ExplorerRow, event: DragEvent];
  visibleItemsChange: [items: ExplorerRow[]];
}>();

function onRowContextMenu(item: ExplorerRow, event: MouseEvent): void {
  emit("rowContextMenu", item, event);
}

function onRowDragStart(item: ExplorerRow, event: DragEvent): void {
  emit("rowDragStart", item, event);
}

function onRowDragOver(item: ExplorerRow, event: DragEvent): void {
  emit("rowDragOver", item, event);
}

function onRowDragLeave(item: ExplorerRow, event: DragEvent): void {
  emit("rowDragLeave", item, event);
}

function onRowDrop(item: ExplorerRow, event: DragEvent): void {
  emit("rowDrop", item, event);
}
</script>

<template>
  <DataTable
    v-if="searchQuery.trim()"
    v-model:page="page"
    :items="searchRows"
    :columns="searchColumns"
    :selectable="false"
    :row-clickable="true"
    :row-class="(file) => !file.textDirect ? 'opacity-60' : 'cursor-pointer'"
    :pagination="true"
    :page-size="30"
    pagination-position="both"
    :empty-message="searchLoading ? 'Searching…' : `No files matching '${searchQuery.trim()}'`"
    @row-click="emit('openGlobalResult', $event)"
  >
    <template #col-fileName="{ item: file }">
      <div class="flex min-w-0 items-center gap-3">
        <Icon
          :icon="file.extension === '.md' ? 'lucide:file-text' : file.extension === '.pdf' ? 'lucide:file-type-2' : 'lucide:file'"
          class="h-4 w-4 shrink-0 text-ink-secondary"
        />
        <div class="min-w-0">
          <div class="truncate text-sm text-theme-200">
            {{ file.fileName }}
          </div>
          <div class="mt-0.5 flex flex-wrap gap-1">
            <span
              v-for="field in file.matchedFields"
              :key="field"
              class="rounded border border-theme-700/80 bg-theme-900/70 px-1.5 py-0.5 text-[10px] text-ink-muted"
            >{{ field }}</span>
          </div>
        </div>
      </div>
    </template>
    <template #col-folderName="{ item: file }">
      <div class="min-w-0 text-xs text-ink-secondary">
        <div class="truncate">
          {{ file.folderName }}
        </div>
        <div
          v-if="file.folderPath && file.folderPath !== file.folderName"
          class="truncate text-[10px] text-ink-faint"
        >
          {{ file.folderPath }}
        </div>
      </div>
    </template>
    <template #col-modifiedAt="{ item: file }">
      <span class="text-xs text-ink-muted">{{ new Date(file.modifiedAt).toLocaleDateString() }}</span>
    </template>
    <template #col-similarity="{ item: file }">
      <span
        class="inline-flex rounded-full border border-accent-500/25 bg-accent-500/10 px-2 py-0.5 text-xs font-medium text-accent-fg"
        :title="`Best chunk cosine similarity: ${((file.similarity || 0) * 100).toFixed(1)}%`"
      >{{ Math.round((file.similarity || 0) * 100) }}%</span>
    </template>
    <template #col-status="{ item: file }">
      <span
        class="inline-flex items-center gap-1.5 text-xs"
        :class="file.status === 'indexed' ? 'text-status-green' : 'text-ink-muted'"
      >
        <Icon
          :icon="statusIcon(file.status)"
          class="h-3.5 w-3.5"
        /> {{ statusLabel(file.status) }}
      </span>
    </template>
  </DataTable>

  <div
    v-else-if="files.length === 0 && childFolders.length === 0 && !filesLoading"
    class="rounded-xl border border-table-border bg-table-surface py-10 text-center text-sm text-ink-muted"
  >
    No files in this folder yet. Upload files to get started.
  </div>

  <div
    v-else-if="explorerView === 'grid'"
    class="grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl border border-table-border bg-table-surface p-3 sm:grid-cols-4 sm:p-4 lg:grid-cols-5 xl:grid-cols-6"
    data-testid="memory-explorer-grid"
  >
    <div
      v-for="folder in childFolders"
      :key="folder.id"
      role="button"
      tabindex="0"
      class="group relative flex min-w-0 min-h-40 cursor-pointer flex-col items-center justify-center rounded-lg px-2 py-3 text-center transition-colors hover:bg-table-hover"
      :class="[
        highlightedFolderId === folder.id || selectedFolders.has(folder.id) ? 'bg-table-selected' : '',
        dropTargetFolderId === folder.id ? 'bg-table-selected ring-1 ring-inset ring-accent-500/60' : '',
      ]"
      @click="emit('openFolder', folder)"
      @keydown.enter="emit('openFolder', folder)"
      @dblclick="emit('openFolder', folder)"
      @contextmenu="emit('openContextMenu', 'folder', $event, folder)"
      @dragover="emit('folderDragOver', folder, $event)"
      @dragleave="emit('folderDragLeave', folder, $event)"
      @drop="emit('folderDrop', folder, $event)"
    >
      <input
        type="checkbox"
        class="absolute left-3 top-3 h-4 w-4 cursor-pointer rounded border-theme-600 bg-theme-900 text-accent-fg opacity-100 transition-opacity focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        :class="{ 'sm:!opacity-100': selectedItemCount > 0 || selectedFolders.has(folder.id) }"
        :checked="selectedFolders.has(folder.id)"
        :aria-label="`${selectedFolders.has(folder.id) ? 'Deselect' : 'Select'} ${folder.name}`"
        @click.stop="emit('toggleGridSelection', rowForFolder(folder), $event)"
      >
      <Icon
        :icon="folder.autoMemoryExcluded ? 'lucide:folder-x' : 'lucide:folder'"
        class="mb-3 h-8 w-8"
        :class="folder.autoMemoryExcluded ? 'text-status-danger' : 'text-status-warning'"
      />
      <span
        class="w-full truncate text-sm font-medium text-theme-200"
        :title="folder.name"
      >{{ folder.name }}</span>
      <span class="mt-1 text-xs text-ink-faint sm:text-sm">{{ folder.fileCount }} file{{ folder.fileCount !== 1 ? 's' : '' }}</span>
      <span
        class="mt-2 inline-flex items-center gap-1 text-xs sm:text-sm"
        :class="folderIndexSummary(folder).colorClass"
      >
        <Icon
          :icon="folderIndexSummary(folder).icon"
          class="h-3 w-3"
          :class="{ 'animate-spin': folderIndexSummary(folder).icon === 'lucide:loader-2' }"
        /> {{ folderIndexSummary(folder).label }}
      </span>
    </div>
    <div
      v-for="file in filteredFiles"
      :key="file.fileName"
      :draggable="true"
      role="button"
      tabindex="0"
      class="group relative flex min-w-0 min-h-40 cursor-pointer flex-col items-center justify-center rounded-lg px-2 py-3 text-center transition-colors hover:bg-table-hover"
      :class="[selectedFiles.has(file.fileName) ? 'bg-table-selected' : '', !file.supported ? 'opacity-50' : '']"
      @click="emit('openDocument', file.fileName)"
      @dblclick="emit('openDocument', file.fileName)"
      @keydown.enter="emit('openDocument', file.fileName)"
      @contextmenu="emit('openContextMenu', 'document', $event, file)"
      @dragstart.stop="emit('documentDragStart', $event, file.fileName)"
      @dragend="emit('documentDragEnd')"
    >
      <input
        v-if="file.supported"
        type="checkbox"
        class="absolute left-3 top-3 h-4 w-4 cursor-pointer rounded border-theme-600 bg-theme-900 text-accent-fg opacity-100 transition-opacity focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        :class="{ 'sm:!opacity-100': selectedItemCount > 0 || selectedFiles.has(file.fileName) }"
        :checked="selectedFiles.has(file.fileName)"
        :aria-label="`${selectedFiles.has(file.fileName) ? 'Deselect' : 'Select'} ${file.fileName}`"
        @click.stop="emit('toggleGridSelection', rowForFile(file), $event)"
      >
      <Icon
        :icon="file.extension === '.md' ? 'lucide:file-text' : file.extension === '.pdf' ? 'lucide:file-type-2' : 'lucide:file'"
        class="mb-3 h-8 w-8"
        :class="file.supported ? 'text-ink-secondary' : 'text-ink-faint'"
      />
      <span
        class="flex w-full min-w-0 items-center justify-center gap-1 truncate text-sm font-medium"
        :class="hasRecentDreamUpdate(file) ? 'text-status-warning' : 'text-theme-200'"
        :title="file.fileName"
      >
        <Icon
          v-if="hasRecentDreamUpdate(file)"
          icon="lucide:moon"
          class="h-3.5 w-3.5 shrink-0"
          aria-label="Updated by a dream within the last 24 hours"
        />
        <span class="truncate">{{ file.fileName }}</span>
      </span>
      <span class="mt-1 text-xs text-ink-faint sm:text-sm">{{ formatFileSize(file.size) }}</span>
      <span
        class="mt-2 inline-flex items-center gap-1 text-xs sm:text-sm"
        :class="isJobActive('reindex', file.fileName) ? 'text-status-warning' : file.status === 'indexed' ? 'text-status-green' : 'text-ink-muted'"
      >
        <Icon
          :icon="isJobActive('reindex', file.fileName) ? 'lucide:loader-2' : statusIcon(file.status)"
          class="h-3 w-3"
          :class="{ 'animate-spin': isJobActive('reindex', file.fileName) }"
        />
        {{ isJobActive('reindex', file.fileName) ? searchIndexProgress(file.fileName) : statusLabel(file.status) }}
      </span>
      <span
        v-if="isJobActive('deep-research', file.fileName)"
        class="mt-1 inline-flex items-center gap-1 text-xs text-status-success sm:text-sm"
      >
        <Icon
          icon="lucide:loader-2"
          class="h-3 w-3 animate-spin"
        /> {{ deepResearchProgress(file.fileName) }}
      </span>
    </div>
  </div>

  <DataTable
    v-else
    v-model:selected-ids="selectedIds"
    v-model:page="page"
    :items="documentRows"
    :columns="columns"
    :sort-group-value="sortGroup"
    :selectable="true"
    :row-selectable="isRowSelectable"
    :row-clickable="true"
    :row-draggable="(item) => item.kind === 'file'"
    :row-class="(item) => item.kind === 'folder' ? (dropTargetFolderId === item.folder.id ? 'bg-accent-500/10 ring-1 ring-inset ring-accent-500/60' : 'cursor-pointer') : !item.supported ? 'opacity-50' : 'cursor-pointer'"
    :pagination="true"
    :page-size="30"
    pagination-position="both"
    initial-sort-key="modifiedAt"
    initial-sort-direction="desc"
    empty-message="No folders or files here yet."
    @row-click="emit('rowClick', $event)"
    @row-contextmenu="onRowContextMenu"
    @row-dragstart="onRowDragStart"
    @row-dragover="onRowDragOver"
    @row-dragleave="onRowDragLeave"
    @row-drop="onRowDrop"
    @row-dragend="emit('documentDragEnd')"
    @visible-items-change="emit('visibleItemsChange', $event)"
  >
    <template #col-name="{ item }">
      <div class="flex min-w-0 items-center gap-3">
        <Icon
          :icon="item.kind === 'folder' ? item.folder.autoMemoryExcluded ? 'lucide:folder-x' : 'lucide:folder' : item.extension === '.md' ? 'lucide:file-text' : item.extension === '.pdf' ? 'lucide:file-type-2' : 'lucide:file'"
          class="h-5 w-5 shrink-0"
          :class="item.kind === 'folder' ? item.folder.autoMemoryExcluded ? 'text-status-danger' : 'text-status-warning' : item.supported ? 'text-ink-secondary' : 'text-ink-faint'"
        />
        <div class="min-w-0">
          <div
            class="flex items-center gap-1 truncate text-sm font-medium"
            :class="item.kind === 'file' && hasRecentDreamUpdate(item) ? 'text-status-warning' : 'text-theme-200'"
          >
            <Icon
              v-if="item.kind === 'file' && hasRecentDreamUpdate(item)"
              icon="lucide:moon"
              class="h-3.5 w-3.5 shrink-0"
              aria-label="Updated by a dream within the last 24 hours"
            /> {{ item.name }}
          </div>
          <div class="mt-0.5 truncate text-[11px] text-ink-faint">
            <template v-if="item.kind === 'folder'">
              {{ item.folder.fileCount }} direct · {{ item.folder.descendantFileCount || 0 }} nested
            </template>
            <template v-else>
              {{ formatFileSize(item.size) }}<template v-if="item.tags.length">
                · {{ item.tags.slice(0, 4).join(', ') }}
              </template>
            </template>
          </div>
        </div>
      </div>
    </template>
    <template #col-modifiedAt="{ item }">
      <span class="text-xs text-ink-muted">{{ new Date(item.modifiedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }}</span>
    </template>
    <template #col-chunkCount="{ item }">
      <span class="text-xs text-ink-secondary">
        <template v-if="item.kind === 'folder'">{{ item.chunkCount || 0 }} items</template>
        <template v-else-if="item.status === 'indexed'">{{ item.chunkCount || 0 }}</template>
        <template v-else-if="item.estimatedChunkCount !== undefined">~{{ item.estimatedChunkCount }}</template>
        <template v-else>—</template>
      </span>
    </template>
    <template #col-deepResearched="{ item }">
      <span
        v-if="item.kind !== 'file'"
        class="text-xs text-ink-faint"
      >Recursive</span>
      <span
        v-else-if="isJobActive('deep-research', item.fileName)"
        class="inline-flex items-center gap-1.5 text-xs text-status-success"
      ><Icon
        icon="lucide:loader-2"
        class="h-3.5 w-3.5 animate-spin"
      /> {{ deepResearchProgress(item.fileName) }}</span>
      <span
        v-else
        class="inline-flex items-center gap-1.5 text-xs"
        :class="item.deepResearched ? 'text-status-green' : 'text-ink-muted'"
      ><Icon
        :icon="item.deepResearched ? 'lucide:check-circle' : 'lucide:circle-dashed'"
        class="h-3.5 w-3.5"
      /> {{ item.deepResearched ? 'Researched' : 'Not researched' }}</span>
    </template>
    <template #col-status="{ item }">
      <span
        v-if="item.kind !== 'file'"
        class="inline-flex items-center gap-1.5 text-xs"
        :class="folderIndexSummary(item.folder).colorClass"
      ><Icon
        :icon="folderIndexSummary(item.folder).icon"
        class="h-3.5 w-3.5"
        :class="{ 'animate-spin': folderIndexSummary(item.folder).icon === 'lucide:loader-2' }"
      /> {{ folderIndexSummary(item.folder).label }}</span>
      <span
        v-else-if="isJobActive('reindex', item.fileName)"
        class="inline-flex items-center gap-1.5 text-xs text-status-warning"
      ><Icon
        icon="lucide:loader-2"
        class="h-3.5 w-3.5 animate-spin"
      /> {{ searchIndexProgress(item.fileName) }}</span>
      <span
        v-else
        class="inline-flex items-center gap-1.5 text-xs"
        :class="item.status === 'indexed' ? 'text-status-green' : 'text-ink-muted'"
      ><Icon
        :icon="statusIcon(item.status)"
        class="h-3.5 w-3.5"
      /> {{ statusLabel(item.status) }}</span>
    </template>
  </DataTable>
</template>
