<script setup lang="ts">
import type { MemoryDiffSegment } from "../../api/types";

defineProps<{
  segments: MemoryDiffSegment[];
}>();

function segmentClass(type: MemoryDiffSegment["type"]): string {
  if (type === "added") return "rounded-sm bg-emerald-500/15 text-emerald-200 shadow-[0_0_0_1px_rgb(16_185_129_/_0.08)]";
  if (type === "removed") return "rounded-sm bg-red-500/10 text-red-300/80 line-through decoration-red-400/70";
  return "text-theme-300";
}
</script>

<template>
  <div class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-theme-800/80 bg-theme-950/70">
    <div class="flex items-center gap-4 border-b border-theme-800/70 px-4 py-2 text-[11px] text-ink-muted">
      <span class="flex items-center gap-1.5">
        <span class="h-2.5 w-2.5 rounded-sm bg-emerald-500/30" /> Added
      </span>
      <span class="flex items-center gap-1.5">
        <span class="h-2.5 w-2.5 rounded-sm bg-red-500/20" /> Replaced
      </span>
    </div>
    <pre v-if="segments.length" class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6"><span
      v-for="(segment, index) in segments"
      :key="index"
      :class="segmentClass(segment.type)"
    >{{ segment.text }}</span></pre>
    <div v-else class="p-6 text-center text-sm text-ink-muted">No changes.</div>
  </div>
</template>
