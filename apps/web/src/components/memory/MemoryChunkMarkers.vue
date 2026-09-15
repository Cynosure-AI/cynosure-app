<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Marked } from "marked";
import type { MemoryDocumentAnalysis } from "../../api/types";
import HoverTooltip from "../shared/HoverTooltip.vue";

interface TextNodeLike {
  isText?: boolean;
  text?: string | null;
}

interface MarkerEditor {
  state: {
    doc: {
      descendants: (callback: (node: TextNodeLike, pos: number) => void) => void;
      resolve?: (pos: number) => { parentOffset: number };
    };
  };
  view: {
    coordsAtPos: (pos: number) => { top: number };
    dom?: HTMLElement;
    domAtPos?: (pos: number) => { node: Node };
  };
  on: (event: "update", callback: () => void) => void;
  off: (event: "update", callback: () => void) => void;
}

const props = defineProps<{
  editor: MarkerEditor | null | undefined;
  chunks: MemoryDocumentAnalysis["chunks"];
}>();

const layerRef = ref<HTMLElement | null>(null);
const markers = ref<Array<{ chunk: MemoryDocumentAnalysis["chunks"][number]; top: number }>>([]);
let resizeObserver: ResizeObserver | null = null;
let boundaryElements = new Set<HTMLElement>();
const markdownParser = new Marked({ breaks: true });
const separatingElements = new Set([
  "ADDRESS", "BLOCKQUOTE", "BR", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
  "LI", "P", "PRE", "TD", "TH",
]);

function appendNormalized(
  value: string,
  position: number,
  characters: string[],
  positions?: number[],
) {
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (/\s/.test(character)) {
      if (characters.length && characters.at(-1) !== " ") {
        characters.push(" ");
        positions?.push(position + index);
      }
    } else {
      characters.push(character);
      positions?.push(position + index);
    }
  }
}

function editorTextMap(editor: MarkerEditor): { text: string; positions: number[] } {
  const characters: string[] = [];
  const positions: number[] = [];
  let previousEnd = -1;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    if (previousEnd >= 0 && pos > previousEnd && characters.at(-1) !== " ") {
      characters.push(" ");
      positions.push(pos);
    }
    appendNormalized(node.text, pos, characters, positions);
    previousEnd = pos + node.text.length;
  });
  return { text: characters.join(""), positions };
}

function markdownText(markdown: string): string {
  const container = document.createElement("div");
  // This detached tree mirrors the markdown-to-HTML conversion used by the
  // editor. It is reduced to text and never attached to the page.
  container.innerHTML = markdownParser.parse(markdown) as string;
  container.querySelectorAll("script, style").forEach((element) => element.remove());
  const characters: string[] = [];
  function visit(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendNormalized(node.textContent || "", 0, characters);
      return;
    }
    const separates = node instanceof HTMLElement && separatingElements.has(node.tagName);
    if (separates) appendNormalized(" ", 0, characters);
    node.childNodes.forEach(visit);
    if (separates) appendNormalized(" ", 0, characters);
  }
  container.childNodes.forEach(visit);
  return characters.join("").trim();
}

function markerPosition(
  haystack: string,
  positions: number[],
  chunkText: string,
  after: number,
): { documentPosition: number; textOffset: number } | null {
  const normalized = markdownText(chunkText);
  if (!normalized) return null;
  // A reasonably long prefix is resilient to markdown formatting differences,
  // while the sequential search disambiguates repeated headings and overlap.
  const needle = normalized.slice(0, 160);
  const offset = haystack.indexOf(needle, Math.max(0, after + 1));
  if (offset < 0 || positions[offset] === undefined) return null;
  return { documentPosition: positions[offset], textOffset: offset };
}

function boundaryElement(editor: MarkerEditor, position: number): HTMLElement | null {
  if (editor.state.doc.resolve?.(position).parentOffset !== 0 || !editor.view.domAtPos || !editor.view.dom) return null;
  const domPosition = editor.view.domAtPos(position).node;
  const element = domPosition instanceof HTMLElement ? domPosition : domPosition.parentElement;
  const block = element?.closest<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table");
  return block && editor.view.dom.contains(block) ? block : null;
}

function updateBoundarySpacing(nextElements: Set<HTMLElement>) {
  for (const element of boundaryElements) {
    if (!nextElements.has(element)) element.classList.remove("memory-chunk-boundary-block");
  }
  for (const element of nextElements) {
    if (!boundaryElements.has(element)) element.classList.add("memory-chunk-boundary-block");
  }
  boundaryElements = nextElements;
}

async function updateMarkers() {
  await nextTick();
  const editor = props.editor;
  const layer = layerRef.value;
  if (!editor || !layer || props.chunks.length < 2) {
    updateBoundarySpacing(new Set());
    markers.value = [];
    return;
  }

  const { text, positions } = editorTextMap(editor);
  const layerTop = layer.getBoundingClientRect().top;
  let previousOffset = -1;
  const nextMarkers: typeof markers.value = [];
  const nextBoundaryElements = new Set<HTMLElement>();
  const matchedChunks: Array<{
    chunk: MemoryDocumentAnalysis["chunks"][number];
    documentPosition: number;
    spaced: boolean;
  }> = [];

  for (const chunk of props.chunks) {
    const match = markerPosition(text, positions, chunk.text, previousOffset);
    if (!match) continue;
    previousOffset = match.textOffset;
    if (chunk.chunkIndex === 0) continue;
    const element = boundaryElement(editor, match.documentPosition);
    if (element) nextBoundaryElements.add(element);
    matchedChunks.push({ chunk, documentPosition: match.documentPosition, spaced: Boolean(element) });
  }

  updateBoundarySpacing(nextBoundaryElements);
  for (const match of matchedChunks) {
    const coords = editor.view.coordsAtPos(match.documentPosition);
    nextMarkers.push({
      chunk: match.chunk,
      top: Math.max(0, coords.top - layerTop - (match.spaced ? 22 : 6)),
    });
  }
  markers.value = nextMarkers;
}

function onEditorUpdate() {
  void updateMarkers();
}

watch(() => [props.editor, props.chunks] as const, ([editor], previousValues) => {
  const previousEditor = previousValues?.[0];
  previousEditor?.off("update", onEditorUpdate);
  editor?.on("update", onEditorUpdate);
  void updateMarkers();
}, { immediate: true });

onMounted(() => {
  if (typeof ResizeObserver !== "undefined" && layerRef.value) {
    resizeObserver = new ResizeObserver(onEditorUpdate);
    resizeObserver.observe(layerRef.value);
  }
  window.addEventListener("resize", onEditorUpdate);
  void updateMarkers();
});

onBeforeUnmount(() => {
  props.editor?.off("update", onEditorUpdate);
  updateBoundarySpacing(new Set());
  resizeObserver?.disconnect();
  window.removeEventListener("resize", onEditorUpdate);
});
</script>

<template>
  <div
    ref="layerRef"
    class="pointer-events-none absolute inset-0 z-[2]"
    aria-hidden="false"
  >
    <div
      v-for="marker in markers"
      :key="marker.chunk.chunkIndex"
      class="pointer-events-auto absolute left-2 right-2"
      :style="{ top: `${marker.top}px` }"
    >
      <HoverTooltip
        placement="mouse"
        :max-width="460"
        block
      >
        <div
          class="group flex w-full items-center gap-2"
          :aria-label="`Chunk ${marker.chunk.chunkIndex + 1} boundary`"
        >
          <div class="h-px flex-1 border-t-2 border-accent-500/55 shadow-[0_0_8px_color-mix(in_srgb,var(--color-accent-500)_25%,transparent)] transition-colors group-hover:border-accent-300" />
          <span class="rounded-full border border-accent-400/60 bg-accent-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-accent-300 shadow-md shadow-black/30 transition-colors group-hover:bg-accent-500/25">
            Chunk {{ marker.chunk.chunkIndex + 1 }}
          </span>
        </div>
        <template #content>
          <div
            class="min-w-64 text-[13px] leading-5 text-theme-200"
            :aria-label="`Summary for chunk ${marker.chunk.chunkIndex + 1}`"
          >
            <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-400">
              Chunk {{ marker.chunk.chunkIndex + 1 }}<span v-if="marker.chunk.sectionPath"> · {{ marker.chunk.sectionPath }}</span>
            </div>
            <p :class="{ 'italic text-theme-500': !marker.chunk.summary }">
              {{ marker.chunk.summary || "Summary unavailable for this chunk." }}
            </p>
            <div
              v-if="marker.chunk.tags.length"
              class="mt-2 flex flex-wrap gap-1"
            >
              <span
                v-for="tag in marker.chunk.tags"
                :key="tag"
                class="rounded border border-theme-700 bg-theme-950 px-1.5 py-0.5 text-[11px] text-theme-400"
              >{{ tag }}</span>
            </div>
          </div>
        </template>
      </HoverTooltip>
    </div>
  </div>
</template>
