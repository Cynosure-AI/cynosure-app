<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Icon } from "@iconify/vue";
import { Marked } from "marked";
import TurndownService from "turndown";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { api } from "../../api/client";
import { useMemoryJobsStore } from "../../stores/memory-jobs.store";
import ModalDialog from "../shared/ModalDialog.vue";

const props = defineProps<{
  show: boolean;
  spaceId: string;
  sourceFile: string;
}>();

const emit = defineEmits<{
  close: [];
  saved: [payload: { fileName: string; chunksStored: number }];
}>();
const memoryJobs = useMemoryJobsStore();

const markdownParser = new Marked({ breaks: true });
const headingLevels = [1, 2, 3] as const;

type HeadingLevel = (typeof headingLevels)[number];

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
});

turndown.addRule("strikethrough", {
  filter: ["s", "del"],
  replacement: (content) => `~~${content}~~`,
});

function tableCellMarkdown(cell: Element): string {
  const text = turndown.turndown(cell.innerHTML).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
  return ` ${text} `;
}

turndown.addRule("table", {
  filter: "table",
  replacement: (_content, node) => {
    const table = node as HTMLTableElement;
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";

    const markdownRows = rows.map(row =>
      `|${Array.from(row.children).map(tableCellMarkdown).join("|")}|`
    );
    const columnCount = rows[0]?.children.length || 1;
    const separator = `|${Array.from({ length: columnCount }, () => " --- ").join("|")}|`;

    return `\n\n${[markdownRows[0], separator, ...markdownRows.slice(1)].join("\n")}\n\n`;
  },
});

const loading = ref(false);
const saving = ref(false);
const error = ref("");
const loadedMarkdown = ref("");
const loadedRevision = ref("");
const editableTitle = ref("");
const currentFileName = ref("");
const editorTick = ref(0);

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      link: false,
    }),
    Link.configure({
      autolink: true,
      openOnClick: false,
      HTMLAttributes: {
        rel: "noopener noreferrer",
        target: "_blank",
      },
    }),
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
  ],
  content: "",
  editorProps: {
    attributes: {
      class: "memory-editor-content",
    },
  },
  onUpdate: () => {
    editorTick.value++;
  },
});

const hasChanges = computed(() => {
  void editorTick.value;
  const current = editor.value ? editorToMarkdown() : "";
  return normalizeMarkdown(current) !== normalizeMarkdown(loadedMarkdown.value);
});

const hasNameChange = computed(() => titleToFileName(editableTitle.value) !== currentFileName.value);
const canSave = computed(() => Boolean(titleToFileName(editableTitle.value)) && (hasChanges.value || hasNameChange.value));

function splitFileName(fileName: string): { stem: string; ext: string } {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return { stem: fileName, ext: ".md" };
  return {
    stem: fileName.slice(0, dotIndex),
    ext: fileName.slice(dotIndex),
  };
}

function titleToFileName(title: string): string {
  const { ext } = splitFileName(currentFileName.value || props.sourceFile);
  let stem = title.trim();
  for (const knownExt of [".md", ".markdown", ".txt"]) {
    if (stem.toLowerCase().endsWith(knownExt)) {
      stem = stem.slice(0, -knownExt.length).trim();
      break;
    }
  }
  return stem ? `${stem}${ext}` : "";
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function markdownToHtml(markdown: string): string {
  return markdownParser.parse(markdown) as string;
}

function editorToMarkdown(): string {
  const html = editor.value?.getHTML() || "";
  return `${turndown.turndown(html).trim()}\n`;
}

async function loadContent() {
  if (!props.show || !props.spaceId || !props.sourceFile || !editor.value) return;
  loading.value = true;
  error.value = "";
  currentFileName.value = props.sourceFile;
  editableTitle.value = splitFileName(props.sourceFile).stem;
  try {
    const res = await api.memorySpaces.getFileContent(props.spaceId, props.sourceFile);
    loadedMarkdown.value = res.content;
    loadedRevision.value = res.revision;
    editor.value.commands.setContent(markdownToHtml(res.content), { emitUpdate: false });
    editorTick.value++;
  } catch (err) {
    error.value = (err as Error).message || "Failed to load memory";
    editor.value.commands.clearContent(false);
  } finally {
    loading.value = false;
  }
}

async function applyRename() {
  const nextFileName = titleToFileName(editableTitle.value);
  if (!nextFileName || nextFileName === currentFileName.value) return currentFileName.value;
  const res = await api.memorySpaces.renameFile(props.spaceId, currentFileName.value, nextFileName);
  currentFileName.value = res.fileName;
  editableTitle.value = splitFileName(res.fileName).stem;
  return res.fileName;
}

async function saveContent() {
  if (!editor.value || saving.value || !canSave.value) return;
  saving.value = true;
  error.value = "";
  try {
    const markdown = editorToMarkdown();
    let chunksStored = 0;
    const fileName = await applyRename();
    if (hasChanges.value) {
      const res = await api.memorySpaces.updateFileContent(
        props.spaceId,
        fileName,
        markdown,
        loadedRevision.value,
      );
      loadedMarkdown.value = markdown;
      loadedRevision.value = res.revision;
      currentFileName.value = res.fileName;
      memoryJobs.upsertJob(res.job);
    }
    editableTitle.value = splitFileName(fileName).stem;
    emit("saved", { fileName, chunksStored });
  } catch (err) {
    error.value = (err as Error).message || "Failed to save memory";
  } finally {
    saving.value = false;
  }
}

function toggleLink() {
  const href = window.prompt("Link URL", editor.value?.getAttributes("link").href || "");
  if (href === null) return;
  if (!href.trim()) {
    editor.value?.chain().focus().unsetLink().run();
    return;
  }
  editor.value?.chain().focus().setLink({ href: href.trim() }).run();
}

function toggleHeading(level: HeadingLevel) {
  editor.value?.chain().focus().toggleHeading({ level }).run();
}

function close() {
  if (saving.value) return;
  emit("close");
}

watch(
  () => [props.show, props.spaceId, props.sourceFile, editor.value] as const,
  () => {
    if (props.show) void loadContent();
  },
);

onBeforeUnmount(() => {
  editor.value?.destroy();
});
</script>

<template>
  <ModalDialog
    :show="show && Boolean(sourceFile)"
    :title="titleToFileName(editableTitle) || sourceFile"
    icon="lucide:edit-3"
    icon-color="accent"
    max-width="max-w-5xl"
    max-height="h-[88vh]"
    @close="close"
  >
    <div class="flex h-full min-h-0 flex-col rounded-2xl overflow-hidden">
      <div class="flex items-center gap-3 px-5 py-3 border-b border-theme-800 bg-theme-950/25 shrink-0">
        <label class="text-xs text-theme-500 shrink-0">Name</label>
        <input
          v-model="editableTitle"
          class="flex-1 min-w-0 bg-theme-950 border border-theme-700 rounded-lg px-3 py-1.5 text-sm text-theme-200 focus:outline-none focus:border-accent-500"
          :disabled="loading || saving"
          @keydown.enter.prevent="saveContent"
        >
        <span class="text-sm text-theme-500 shrink-0">{{ splitFileName(currentFileName || sourceFile).ext }}</span>
      </div>

      <div class="flex items-center gap-1 px-4 py-2 border-b border-theme-800 bg-theme-950/35 shrink-0 overflow-x-auto">
        <button
          v-for="button in [
            { icon: 'lucide:bold', title: 'Bold', action: () => editor?.chain().focus().toggleBold().run(), active: editor?.isActive('bold') },
            { icon: 'lucide:italic', title: 'Italic', action: () => editor?.chain().focus().toggleItalic().run(), active: editor?.isActive('italic') },
            { icon: 'lucide:strikethrough', title: 'Strike', action: () => editor?.chain().focus().toggleStrike().run(), active: editor?.isActive('strike') },
            { icon: 'lucide:code', title: 'Inline code', action: () => editor?.chain().focus().toggleCode().run(), active: editor?.isActive('code') },
          ]"
          :key="button.title"
          :title="button.title"
          :class="button.active ? 'bg-accent-500/15 text-accent-300' : 'text-theme-400 hover:text-theme-100 hover:bg-theme-800/70'"
          class="p-2 rounded-lg transition-colors shrink-0 disabled:opacity-40"
          :disabled="!editor || loading"
          @click="button.action"
        >
          <Icon
            :icon="button.icon"
            class="w-4 h-4"
          />
        </button>

        <div class="mx-1 h-5 w-px bg-theme-800 shrink-0" />

        <button
          v-for="level in headingLevels"
          :key="level"
          :title="`Heading ${level}`"
          :class="editor?.isActive('heading', { level }) ? 'bg-accent-500/15 text-accent-300' : 'text-theme-400 hover:text-theme-100 hover:bg-theme-800/70'"
          class="px-2.5 py-2 rounded-lg transition-colors text-xs font-semibold shrink-0 disabled:opacity-40"
          :disabled="!editor || loading"
          @click="toggleHeading(level)"
        >
          H{{ level }}
        </button>

        <div class="mx-1 h-5 w-px bg-theme-800 shrink-0" />

        <button
          v-for="button in [
            { icon: 'lucide:list', title: 'Bullet list', action: () => editor?.chain().focus().toggleBulletList().run(), active: editor?.isActive('bulletList') },
            { icon: 'lucide:list-ordered', title: 'Numbered list', action: () => editor?.chain().focus().toggleOrderedList().run(), active: editor?.isActive('orderedList') },
            { icon: 'lucide:quote', title: 'Quote', action: () => editor?.chain().focus().toggleBlockquote().run(), active: editor?.isActive('blockquote') },
            { icon: 'lucide:square-code', title: 'Code block', action: () => editor?.chain().focus().toggleCodeBlock().run(), active: editor?.isActive('codeBlock') },
            { icon: 'lucide:link', title: 'Link', action: toggleLink, active: editor?.isActive('link') },
          ]"
          :key="button.title"
          :title="button.title"
          :class="button.active ? 'bg-accent-500/15 text-accent-300' : 'text-theme-400 hover:text-theme-100 hover:bg-theme-800/70'"
          class="p-2 rounded-lg transition-colors shrink-0 disabled:opacity-40"
          :disabled="!editor || loading"
          @click="button.action"
        >
          <Icon
            :icon="button.icon"
            class="w-4 h-4"
          />
        </button>
      </div>

      <div
        v-if="error"
        class="px-5 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-300 shrink-0"
      >
        {{ error }}
      </div>

      <div class="relative flex-1 min-h-0 overflow-y-auto bg-theme-950/45">
        <div
          v-if="loading"
          class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-theme-950/65 text-theme-500 text-sm"
        >
          <Icon
            icon="lucide:loader-2"
            class="w-4 h-4 animate-spin"
          />
          Loading…
        </div>
        <EditorContent
          :editor="editor"
          class="memory-editor-shell"
        />
      </div>
    </div>

    <template #actions>
      <div class="flex justify-end gap-2">
        <button
          class="px-3 py-1.5 text-theme-400 hover:text-theme-100 rounded-lg text-sm transition-colors"
          :disabled="saving"
          @click="close"
        >
          Close
        </button>
        <button
          :disabled="loading || saving || !canSave"
          class="px-3 py-1.5 bg-accent-500/15 hover:bg-accent-500/25 text-accent-300 rounded-lg text-sm transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          @click="saveContent"
        >
          <Icon
            :icon="saving ? 'lucide:loader-2' : 'lucide:save'"
            class="w-4 h-4"
            :class="{ 'animate-spin': saving }"
          />
          Save
        </button>
      </div>
    </template>
  </ModalDialog>
</template>

<style scoped>
.memory-editor-shell {
  min-height: 100%;
}

:deep(.memory-editor-content) {
  min-height: calc(88vh - 132px);
  padding: 1.25rem;
  color: var(--color-theme-200);
  outline: none;
  line-height: 1.65;
}

:deep(.memory-editor-content > *:first-child) {
  margin-top: 0;
}

:deep(.memory-editor-content p) {
  margin: 0.55rem 0;
}

:deep(.memory-editor-content h1),
:deep(.memory-editor-content h2),
:deep(.memory-editor-content h3) {
  color: var(--color-theme-100);
  font-weight: 700;
  letter-spacing: 0;
  margin: 1rem 0 0.5rem;
}

:deep(.memory-editor-content h1) {
  font-size: 1.5rem;
  line-height: 2rem;
}

:deep(.memory-editor-content h2) {
  font-size: 1.25rem;
  line-height: 1.75rem;
}

:deep(.memory-editor-content h3) {
  font-size: 1.125rem;
  line-height: 1.65rem;
}

:deep(.memory-editor-content ul),
:deep(.memory-editor-content ol) {
  margin: 0.5rem 0 0.5rem 1.25rem;
  padding-left: 1rem;
}

:deep(.memory-editor-content ul) {
  list-style-type: disc;
}

:deep(.memory-editor-content ol) {
  list-style-type: decimal;
}

:deep(.memory-editor-content blockquote) {
  margin: 0.65rem 0;
  padding: 0.4rem 0.75rem;
  border-left: 3px solid var(--color-theme-600);
  background: rgba(39, 39, 42, 0.35);
  color: var(--color-theme-300);
}

:deep(.memory-editor-content pre) {
  margin: 0.75rem 0;
  padding: 0.85rem;
  border-radius: 0.5rem;
  background: var(--color-theme-950);
  border: 1px solid var(--color-theme-800);
  overflow-x: auto;
}

:deep(.memory-editor-content code) {
  color: var(--color-accent-300);
}

:deep(.memory-editor-content :not(pre) > code) {
  padding: 0.1rem 0.3rem;
  border-radius: 0.25rem;
  background: var(--color-theme-800);
}

:deep(.memory-editor-content a) {
  color: var(--color-accent-300);
  text-decoration: underline;
  text-underline-offset: 2px;
}

:deep(.memory-editor-content table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0;
  font-size: 0.85rem;
  border: 1px solid var(--color-theme-700);
  border-radius: 0.5rem;
  overflow: hidden;
}

:deep(.memory-editor-content thead) {
  background: var(--color-theme-700);
}

:deep(.memory-editor-content th) {
  padding: 0.5rem 0.75rem;
  text-align: left;
  font-weight: 600;
  color: var(--color-theme-100);
  border-bottom: 2px solid var(--color-theme-600);
  border-right: 1px solid var(--color-theme-600);
  white-space: nowrap;
}

:deep(.memory-editor-content th:last-child) {
  border-right: none;
}

:deep(.memory-editor-content td) {
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--color-theme-700);
  border-right: 1px solid var(--color-theme-700);
  color: var(--color-theme-300);
  vertical-align: top;
}

:deep(.memory-editor-content td:last-child) {
  border-right: none;
}

:deep(.memory-editor-content tr:last-child td) {
  border-bottom: none;
}

:deep(.memory-editor-content tbody tr:nth-child(even)) {
  background: var(--color-theme-800);
}

:deep(.memory-editor-content tbody tr:nth-child(odd)) {
  background: color-mix(in srgb, var(--color-theme-800) 40%, var(--color-theme-900));
}

:deep(.memory-editor-content .column-resize-handle) {
  bottom: -2px;
  pointer-events: none;
  position: absolute;
  right: -2px;
  top: 0;
  width: 4px;
  background-color: var(--color-accent-500);
}
</style>
