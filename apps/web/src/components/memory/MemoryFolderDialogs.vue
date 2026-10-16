<script setup lang="ts">
import { ref } from "vue";
import { Icon } from "@iconify/vue";
import { api } from "../../api/client";
import type { MemoryFolder } from "../../api/types";
import ModalDialog from "../shared/ModalDialog.vue";

/** Create, rename, remove, and opt-in dialogs shared by every memory folder browser. */
const props = defineProps<{
  spaces: MemoryFolder[];
}>();

const emit = defineEmits<{
  /** A folder was created, renamed, or changed; the id is the folder to show. */
  saved: [folderId: string];
  /** A folder setting changed without anything to navigate to. */
  changed: [];
  removed: [folder: MemoryFolder];
  error: [message: string];
}>();

const showFolderDialog = ref(false);
const editingFolder = ref<MemoryFolder | null>(null);
const parentForCreate = ref<MemoryFolder | null>(null);
const folderName = ref("");
const folderDescription = ref("");
const saving = ref(false);
const saveError = ref("");
const pendingDeleteFolder = ref<MemoryFolder | null>(null);

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function openCreate(parent: MemoryFolder | null): void {
  editingFolder.value = null;
  parentForCreate.value = parent;
  folderName.value = "";
  folderDescription.value = "";
  saveError.value = "";
  showFolderDialog.value = true;
}

function openEdit(folder: MemoryFolder): void {
  if (folder.isUncategorized) return;
  editingFolder.value = folder;
  parentForCreate.value = null;
  folderName.value = folder.name;
  folderDescription.value = folder.description;
  saveError.value = "";
  showFolderDialog.value = true;
}

function closeFolderDialog(): void {
  if (!saving.value) showFolderDialog.value = false;
}

function relativePathForName(folder: MemoryFolder, name: string): string {
  const current = folder.folderPath || "";
  const slash = current.lastIndexOf("/");
  return slash >= 0 ? `${current.slice(0, slash)}/${name}` : name;
}

async function saveFolder(): Promise<void> {
  const name = folderName.value.trim();
  if (!name || saving.value) return;
  saving.value = true;
  saveError.value = "";
  try {
    if (editingFolder.value) {
      const updated = await api.memoryFolders.update(editingFolder.value.id, {
        name,
        description: folderDescription.value,
        folderPath: relativePathForName(editingFolder.value, name),
      });
      emit("saved", updated.id);
    } else {
      const created = await api.memoryFolders.create(name, folderDescription.value, parentForCreate.value?.folderPath || "");
      emit("saved", created.id);
    }
    showFolderDialog.value = false;
  } catch (cause) {
    saveError.value = messageOf(cause) || "The folder could not be saved.";
  } finally {
    saving.value = false;
  }
}

function confirmRemove(folder: MemoryFolder): void {
  const prefix = folder.folderPath ? `${folder.folderPath}/` : "";
  const hasSubfolders = Boolean(prefix && props.spaces.some(candidate => candidate.folderPath?.startsWith(prefix)));
  if (folder.fileCount === 0 && !hasSubfolders) {
    void removeFolder(folder);
    return;
  }
  pendingDeleteFolder.value = folder;
}

async function removeFolder(folder: MemoryFolder): Promise<void> {
  pendingDeleteFolder.value = null;
  try {
    await api.memoryFolders.remove(folder.id);
    emit("removed", folder);
  } catch (cause) {
    emit("error", `Could not remove ${folder.name}: ${messageOf(cause)}`);
  }
}

async function toggleAutoMemoryExclusion(folder: MemoryFolder): Promise<void> {
  try {
    await api.memoryFolders.update(folder.id, { autoMemoryExcluded: !folder.autoMemoryExcluded });
    emit("changed");
  } catch (cause) {
    emit("error", `Could not update ${folder.name}: ${messageOf(cause)}`);
  }
}

defineExpose({ openCreate, openEdit, confirmRemove, toggleAutoMemoryExclusion });
</script>

<template>
  <ModalDialog
    :show="showFolderDialog"
    :title="editingFolder ? 'Edit folder' : 'New memory folder'"
    :icon="editingFolder ? 'lucide:folder-pen' : 'lucide:folder-plus'"
    @close="closeFolderDialog"
  >
    <form
      class="space-y-3"
      @submit.prevent="saveFolder"
    >
      <div
        v-if="!editingFolder"
        class="text-xs text-ink-muted"
      >
        Inside: <span class="text-theme-300">{{ parentForCreate?.folderPath || parentForCreate?.name || "Memory root" }}</span>
      </div>
      <div>
        <label
          for="memory-folder-name"
          class="mb-1 block text-xs text-ink-secondary"
        >Name</label>
        <input
          id="memory-folder-name"
          v-model="folderName"
          type="text"
          class="w-full rounded-lg border border-theme-700 bg-theme-800 px-3 py-2 text-sm text-theme-200 placeholder:text-ink-muted focus:border-theme-500 focus:outline-none"
          placeholder="e.g. Project Notes"
          :disabled="saving"
        >
        <div
          v-if="!editingFolder"
          class="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-muted"
        >
          <Icon
            icon="lucide:info"
            class="mt-0.5 h-3 w-3 shrink-0"
          />
          <span>
            New folders are included in automatic memory routing by default. You can exclude them from the folder menu at any time.
          </span>
        </div>
      </div>
      <div>
        <label
          for="memory-folder-description"
          class="mb-1 block text-xs text-ink-secondary"
        >Description (optional)</label>
        <input
          id="memory-folder-description"
          v-model="folderDescription"
          type="text"
          class="w-full rounded-lg border border-theme-700 bg-theme-800 px-3 py-2 text-sm text-theme-200 placeholder:text-ink-muted focus:border-theme-500 focus:outline-none"
          :disabled="saving"
        >
      </div>
      <p
        v-if="saveError"
        role="alert"
        class="text-sm text-status-danger"
      >
        {{ saveError }}
      </p>
      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-sm text-ink-secondary hover:text-theme-200"
          :disabled="saving"
          @click="closeFolderDialog"
        >
          Cancel
        </button>
        <button
          type="submit"
          :disabled="!folderName.trim() || saving"
          class="rounded-lg accent-action bg-accent-600 px-4 py-1.5 text-sm text-accent-on hover:bg-accent-500 disabled:opacity-50"
        >
          {{ saving ? "Saving…" : editingFolder ? "Save" : "Create" }}
        </button>
      </div>
    </form>
  </ModalDialog>

  <ModalDialog
    :show="Boolean(pendingDeleteFolder)"
    title="Remove memory folder"
    icon="lucide:trash-2"
    icon-color="red"
    @close="pendingDeleteFolder = null"
  >
    <p class="leading-relaxed text-ink-secondary">
      Remove <strong class="text-theme-200">{{ pendingDeleteFolder?.name }}</strong>? Its folder will be moved to the memory trash and its indexes will be removed.
    </p>
    <template #actions>
      <button
        class="w-full rounded-xl bg-red-600 px-4 py-3 text-center font-medium text-white transition-colors hover:bg-red-500"
        @click="removeFolder(pendingDeleteFolder!)"
      >
        Remove folder
      </button>
      <button
        class="w-full rounded-xl bg-theme-800 px-4 py-3 text-center font-medium text-theme-300 transition-colors hover:bg-theme-700"
        @click="pendingDeleteFolder = null"
      >
        Cancel
      </button>
    </template>
  </ModalDialog>
</template>
