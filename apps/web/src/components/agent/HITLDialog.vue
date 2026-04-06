<script setup lang="ts">
import { ref } from 'vue'
import { useAgentStore } from '../../stores/agent.store'
import { useChatStore } from '../../stores/chat.store'
import { Icon } from '@iconify/vue'

const agentStore = useAgentStore()
const chatStore = useChatStore()
const denyReason = ref('')
const showReasonInput = ref(false)
const expandedArgs = ref<Set<number>>(new Set())

function approve(): void {
  agentStore.respondHITL(true)
  resetState()
}

function deny(): void {
  if (showReasonInput.value) {
    agentStore.respondHITL(false, denyReason.value || undefined)
    resetState()
  } else {
    showReasonInput.value = true
  }
}

function cancelDeny(): void {
  showReasonInput.value = false
  denyReason.value = ''
}

function resetState(): void {
  showReasonInput.value = false
  denyReason.value = ''
  expandedArgs.value.clear()
}

function formatArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

function truncateArgs(args: string, limit = 250): string {
  const formatted = formatArgs(args)
  if (formatted.length <= limit) return formatted
  return formatted.slice(0, limit) + '…'
}

function toggleExpand(index: number): void {
  const s = new Set(expandedArgs.value)
  if (s.has(index)) s.delete(index)
  else s.add(index)
  expandedArgs.value = s
}
</script>

<template>
  <div
    v-if="agentStore.pendingHITL && (!agentStore.pendingHITL.conversationId || agentStore.pendingHITL.conversationId === chatStore.activeConversationId)"
    class="flex gap-4 px-4 py-3 justify-start"
  >
    <div class="relative shrink-0 mt-1">
      <div class="relative w-8 h-8 rounded-full flex items-center justify-center bg-amber-500/20 text-amber-500 border border-amber-500/30 shadow-sm">
        <Icon icon="mdi:warning-circle-outline" />
      </div>
    </div>

    <div class="w-full max-w-[85%] rounded-xl border border-amber-500/30 bg-zinc-800 shadow-lg shadow-black/20 overflow-hidden flex flex-col">
      <div class="flex items-center justify-between px-4 py-2.5 bg-amber-500/5 border-b border-zinc-700/50">
        <span class="text-sm font-semibold text-amber-500 tracking-wide uppercase text-[11px]">Action Required</span>
        <span class="text-xs font-medium text-zinc-400 bg-zinc-900/50 px-2 py-0.5 rounded-full border border-zinc-700/50">
          {{ agentStore.pendingHITL.toolCalls.length }} tool{{ agentStore.pendingHITL.toolCalls.length > 1 ? 's' : '' }} requested
        </span>
      </div>

      <div class="px-4 py-3 space-y-3">
        <div
          v-for="(tc, i) in agentStore.pendingHITL.toolCalls"
          :key="i"
          class="flex flex-col gap-1.5"
        >
          <div class="flex items-center justify-between">
            <span class="rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-[11px] text-blue-400 font-mono font-medium">
              <span class="text-blue-500/50 mr-1">ƒ</span>{{ tc.name }}
            </span>
            <button
              v-if="formatArgs(tc.arguments).length > 250"
              class="text-[10px] font-medium text-zinc-500 hover:text-zinc-300 transition-colors uppercase tracking-wider"
              @click="toggleExpand(i)"
            >
              {{ expandedArgs.has(i) ? 'Show Less' : 'Show More' }}
            </button>
          </div>
          
          <pre
            v-if="tc.arguments"
            class="mt-0.5 text-[11px] text-zinc-300 whitespace-pre-wrap break-all bg-zinc-950/50 border border-zinc-700/50 rounded-lg p-2.5 overflow-x-auto max-h-40 overflow-y-auto shadow-inner font-mono leading-relaxed custom-scrollbar"
          >{{ expandedArgs.has(i) ? formatArgs(tc.arguments) : truncateArgs(tc.arguments) }}</pre>
        </div>
      </div>

      <Transition name="slide-down">
        <div
          v-if="showReasonInput"
          class="px-4 pb-3"
        >
          <input
            v-model="denyReason"
            type="text"
            placeholder="Why is this being denied? (optional)"
            class="w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none transition-all shadow-inner"
            autofocus
            @keydown.enter="deny"
            @keydown.escape="cancelDeny"
          >
        </div>
      </Transition>

      <div class="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-zinc-700/50 bg-zinc-800/80">
        <button
          v-if="showReasonInput"
          class="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50 transition-all focus:outline-none focus:ring-2 focus:ring-zinc-500"
          @click="cancelDeny"
        >
          Cancel
        </button>
        <button
          class="rounded-lg px-4 py-1.5 text-xs font-semibold transition-all focus:outline-none focus:ring-2"
          :class="showReasonInput 
            ? 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 focus:ring-red-500' 
            : 'bg-zinc-700/50 text-zinc-300 border border-zinc-600/50 hover:bg-zinc-700 hover:text-white focus:ring-zinc-500'"
          @click="deny"
        >
          {{ showReasonInput ? 'Confirm Deny' : 'Deny Request' }}
        </button>
        <button
          v-if="!showReasonInput"
          class="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-4 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300 transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500"
          @click="approve"
        >
          Approve
        </button>
      </div>
    </div>
  </div>
</template>
