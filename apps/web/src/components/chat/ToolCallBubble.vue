<script setup lang="ts">
import { ref } from 'vue'
import type { ToolCallDisplay } from '../../stores/agent.store'
import { usePreferencesStore } from '../../stores/preferences.store'

defineProps<{
  toolCalls: ToolCallDisplay[]
  results?: { name: string; success: boolean; output: string; error?: string }[]
  isActive?: boolean
}>()

const prefs = usePreferencesStore()
const expanded = ref(prefs.autoExpandToolCalls)

function prettifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
</script>

<template>
  <div class="flex gap-3 px-4 py-1.5 justify-start">
    <div
      class="w-7 h-7 rounded-full flex items-center justify-center text-xs shrink-0 mt-0.5 bg-zinc-700 text-zinc-400"
    >
      ⚙
    </div>
    <div
      class="max-w-[80%] rounded-xl border border-zinc-700/50 bg-zinc-800/50 text-xs overflow-hidden"
    >
      <button
        class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-700/30 transition"
        @click="expanded = !expanded"
      >
        <span
          v-if="isActive"
          class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"
        />
        <span class="text-zinc-400">
          {{ isActive ? 'Running' : 'Ran' }} {{ toolCalls.length }} tool{{
            toolCalls.length > 1 ? 's' : ''
          }}:
        </span>
        <span
          v-for="tc in toolCalls.slice(0, 3)"
          :key="tc.name"
          class="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-300"
        >
          {{ tc.name }}
        </span>
        <span
          v-if="toolCalls.length > 3"
          class="text-zinc-500 text-[10px]"
        >
          +{{ toolCalls.length - 3 }}
        </span>
        <svg
          class="ml-auto h-3 w-3 text-zinc-500 transition-transform"
          :class="{ 'rotate-180': expanded }"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      <div
        v-if="expanded"
        class="border-t border-zinc-700/50 p-2 space-y-2"
      >
        <div
          v-for="(tc, i) in toolCalls"
          :key="i"
          class="rounded bg-zinc-900/70 p-2"
        >
          <div class="font-medium text-blue-300 mb-1">
            {{ tc.name }}
          </div>
          <pre
            v-if="tc.arguments"
            class="text-[10px] text-zinc-400 whitespace-pre-wrap break-all bg-zinc-950/50 rounded p-1.5 overflow-x-auto"
          >{{ prettifyJson(tc.arguments) }}</pre>
          <div
            v-if="results?.[i]"
            class="mt-1.5 border-t border-zinc-700/30 pt-1.5"
          >
            <div class="flex items-center gap-1 mb-0.5">
              <span
                :class="results[i].success ? 'text-emerald-400' : 'text-red-400'"
                class="text-[10px] font-bold"
              >
                {{ results[i].success ? '✓' : '✗' }}
              </span>
              <span class="text-zinc-500">Result</span>
            </div>
            <pre
              class="text-[10px] whitespace-pre-wrap break-all bg-zinc-950/50 rounded p-1.5 overflow-x-auto max-h-64 overflow-y-auto font-mono"
              :class="results[i].success ? 'text-zinc-400' : 'text-red-300'"
            >{{ prettifyJson(results[i].output) }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
