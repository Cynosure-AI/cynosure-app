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
    };
  };
  view: {
    coordsAtPos: (pos: number) => { top: number };
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

async function updateMarkers() {
  await nextTick();
  const editor = props.editor;
  const layer = layerRef.value;
  if (!editor || !layer || props.chunks.length < 2) {
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
    if (chunk.chunkIndex === 0) continue;
    const coords = editor.view.coordsAtPos(match.documentPosition);
    nextMarkers.push({ chunk, top: Math.max(0, coords.top - layerTop - 4) });
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
        :max-width="380"
        block
      >
        <div
          class="group flex w-full items-center gap-2"
          :aria-label="`Chunk ${marker.chunk.chunkIndex + 1} boundary`"
        >
          <div class="h-px flex-1 border-t border-dashed border-accent-500/35 group-hover:border-accent-400/70" />
          <span class="rounded-full border border-accent-500/30 bg-theme-950/95 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent-400/80 shadow-sm">
            Chunk {{ marker.chunk.chunkIndex + 1 }}
          </span>
        </div>
        <template #content>
          <div
            class="min-w-52 text-theme-200"
            :aria-label="`Summary for chunk ${marker.chunk.chunkIndex + 1}`"
          >
            <div class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-accent-400">
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
                class="rounded border border-theme-700 bg-theme-950 px-1.5 py-0.5 text-[10px] text-theme-400"
              >{{ tag }}</span>
            </div>
          </div>
        </template>
      </HoverTooltip>
    </div>
  </div>
</template>
