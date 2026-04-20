<script setup lang="ts">
import type { AgentDefinition } from '../../api/types'
import { Icon } from '@iconify/vue'

defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
</script>

<template>
  <div class="space-y-5">
    <!-- Cron Prompt -->
    <div class="rounded-xl border border-zinc-700 bg-zinc-800 p-5">
      <div class="flex items-center gap-2 mb-1">
        <Icon
          icon="lucide:file-clock"
          class="w-4 h-4 text-sky-400"
        />
        <h3 class="text-sm font-medium text-zinc-200">
          Cron Prompt
        </h3>
        <span class="text-[10px] text-zinc-600 font-mono">CRON.md</span>
      </div>
      <p class="text-xs text-zinc-500 mb-4">
        Instructions for the agent when it wakes up on a cron trigger.
        Describe the task the agent should perform — API calls, file checks, data processing, etc.
        The agent can create notifications to alert you of anything noteworthy.
      </p>
      <textarea
        :value="agent.cronPrompt"
        placeholder="Example: Query the production API health endpoint. If any service returns a non-200 status, notify the user with the service name and error."
        class="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none h-48 font-mono"
        @change="emit('update', 'cronPrompt', ($event.target as HTMLTextAreaElement).value)"
      />
    </div>

    <!-- Info -->
    <div class="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-4">
      <div class="flex gap-3">
        <Icon
          icon="lucide:lightbulb"
          class="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
        />
        <div class="text-xs text-zinc-500 space-y-1.5">
          <p>
            <strong class="text-zinc-400">How it works:</strong> At each scheduled time, the agent receives this cron prompt and runs a full turn — it can use tools, call APIs, and process data.
          </p>
          <p>
            To create and manage cron schedules, go to the <strong class="text-zinc-400">Cron</strong> page in the sidebar. The same agent can be reused for multiple cron jobs with different schedules.
          </p>
          <p>
            If the agent discovers something noteworthy, it creates a <strong class="text-zinc-400">notification</strong> visible in the sidebar bell icon. Click a notification to jump to the cron conversation.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
