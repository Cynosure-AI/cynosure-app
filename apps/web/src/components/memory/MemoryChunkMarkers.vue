<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
    };
  };
  view: {
    coordsAtPos: (pos: number) => { top: number; bottom?: number };
    dom?: HTMLElement;
    domAtPos?: (pos: number) => { node: Node };
  };
  on: (event: "update", callback: () => void) => void;
  off: (event: "update", callback: () => void) => void;
}

const props = defineProps<{
  editor: MarkerEditor | null | undefined;
  chunks: MemoryDocumentAnalysis["chunks"];
  showDetails?: boolean;
}>();

/** Minimum vertical distance between two badges so boundaries never stack up. */
const MARKER_SPACING = 22;

const layerRef = ref<HTMLElement | null>(null);
const markers = ref<Array<{ chunk: MemoryDocumentAnalysis["chunks"][number]; top: number; first: boolean }>>([]);
const hoveredIndex = ref<number | null>(null);
const hoveredMarker = computed(() =>
  hoveredIndex.value === null
    ? null
    : markers.value.find((marker) => marker.chunk.chunkIndex === hoveredIndex.value) ?? null,
);
let resizeObserver: ResizeObserver | null = null;
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
  if (!editor.view.domAtPos || !editor.view.dom) return null;
  const domPosition = editor.view.domAtPos(position).node;
  const element = domPosition instanceof HTMLElement ? domPosition : domPosition.parentElement;
  const block = element?.closest<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table");
  return block && editor.view.dom.contains(block) ? block : null;
}

async function updateMarkers() {
  await nextTick();
  const editor = props.editor;
  const layer = layerRef.value;
  if (!editor || !layer || !props.chunks.length) {
    markers.value = [];
    return;
  }

  const { text, positions } = editorTextMap(editor);
  const layerTop = layer.getBoundingClientRect().top;
  let previousOffset = -1;
  const nextMarkers: typeof markers.value = [];

  for (const chunk of props.chunks) {
    const match = markerPosition(text, positions, chunk.text, previousOffset);
    if (!match) continue;
    previousOffset = match.textOffset;
    // Anchor the marker on the first line of the chunk's opening block so the
    // label aligns with the heading/paragraph instead of floating between blocks.
    const element = boundaryElement(editor, match.documentPosition);
    const anchorTop = element
      ? element.getBoundingClientRect().top
      : editor.view.coordsAtPos(match.documentPosition).top;
    nextMarkers.push({
      chunk,
      top: Math.max(MARKER_SPACING / 2, anchorTop - layerTop),
      first: chunk.chunkIndex === 0,
    });
  }

  // Keep badges legible when consecutive boundaries land on the same line.
  nextMarkers.sort((a, b) => a.top - b.top);
  let lastTop = Number.NEGATIVE_INFINITY;
  for (const marker of nextMarkers) {
    marker.top = Math.max(marker.top, lastTop + MARKER_SPACING);
    lastTop = marker.top;
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
  resizeObserver?.disconnect();
  window.removeEventListener("resize", onEditorUpdate);
});
</script>

<template>
  <div
    ref="layerRef"
    class="pointer-events-none absolute inset-0 z-2"
    aria-hidden="false"
  >
    <div
      v-if="hoveredMarker"
      class="pointer-events-none absolute inset-x-0 h-px -translate-y-1/2 bg-linear-to-l from-accent-400/80 via-accent-500/45 to-accent-500/10"
      :style="{ top: `${hoveredMarker.top}px` }"
    />
    <div
      v-for="marker in markers"
      :key="marker.chunk.chunkIndex"
      class="pointer-events-auto absolute right-0 flex -translate-y-1/2 items-center gap-1.5"
      :style="{ top: `${marker.top}px` }"
      @mouseenter="hoveredIndex = marker.chunk.chunkIndex"
      @mouseleave="hoveredIndex = hoveredIndex === marker.chunk.chunkIndex ? null : hoveredIndex"
    >
      <HoverTooltip
        placement="mouse"
        :max-width="460"
        :disabled="showDetails === false"
        block
      >
        <div
          class="group flex items-center"
          :aria-label="marker.first ? 'Chunk 1 start' : `Chunk ${marker.chunk.chunkIndex + 1} boundary`"
        >
          <div class="h-px w-5 bg-linear-to-r from-transparent to-accent-500/60 transition-colors group-hover:to-accent-300" />
          <span class="rounded-l-full border border-r-0 border-accent-400/50 bg-accent-500/15 py-1 pl-2.5 pr-3 text-[10px] font-bold uppercase tracking-wide text-accent-fg shadow-md shadow-black/30 backdrop-blur-sm transition-colors group-hover:bg-accent-500/25">
            Chunk {{ marker.chunk.chunkIndex + 1 }}
          </span>
        </div>
        <template #content>
          <div
            class="min-w-64 text-[13px] leading-5 text-theme-200"
            :aria-label="`Summary for chunk ${marker.chunk.chunkIndex + 1}`"
          >
            <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-fg">
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
