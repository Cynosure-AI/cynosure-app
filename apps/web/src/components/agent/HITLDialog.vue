<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAgentStore, type ToolCallDisplay } from '../../stores/agent-runtime.store'
import { useChatStore } from '../../stores/chat.store'
import { Icon } from '@iconify/vue'
import RichContent from '../shared/RichContent.vue'
import { formatRichContent } from '../../utils/rich-content'

const agentStore = useAgentStore()
const chatStore = useChatStore()
const denyReason = ref('')
const showReasonInput = ref(false)
const expandedArgs = ref<Set<number>>(new Set())
const showApproveDropdown = ref(false)
type ToolEffect = 'destructive' | 'write' | 'read' | 'unknown'

function toolEffect(toolCall: ToolCallDisplay): ToolEffect {
  if (toolCall.annotations?.destructiveHint === true) return 'destructive'
  if (toolCall.annotations?.readOnlyHint === false) return 'write'
  if (toolCall.annotations?.readOnlyHint === true) return 'read'
  return 'unknown'
}

function toolEffectLabel(toolCall: ToolCallDisplay): string {
  const effect = toolEffect(toolCall)
  return effect === 'unknown' ? 'Unclassified' : effect[0].toUpperCase() + effect.slice(1)
}

function toolCardClass(toolCall: ToolCallDisplay): string {
  const effect = toolEffect(toolCall)
  if (effect === 'destructive') return 'border-red-500/30 bg-red-500/5'
  if (effect === 'write') return 'border-amber-500/30 bg-amber-500/5'
  if (effect === 'read') return 'border-sky-500/30 bg-sky-500/5'
  return ''
}

function toolEffectBadgeClass(toolCall: ToolCallDisplay): string {
  const effect = toolEffect(toolCall)
  if (effect === 'destructive') return 'border-red-500/30 bg-red-500/10 text-red-400'
  if (effect === 'write') return 'border-amber-500/30 bg-amber-500/10 text-amber-400'
  if (effect === 'read') return 'border-sky-500/30 bg-sky-500/10 text-sky-400'
  return 'border-theme-700/60 bg-theme-900/60 text-theme-500'
}

const approveAllLabel = computed(() => {
  const names = [...new Set(agentStore.pendingHITL?.toolCalls.map(tc => tc.name) ?? [])]
  return `Allow All (${names.join(', ')})`
})

function approve(): void {
  agentStore.respondHITL(true, undefined, 'once')
  resetState()
}

function approveSession(): void {
  showApproveDropdown.value = false
  agentStore.respondHITL(true, undefined, 'session')
  resetState()
}

function approveAllToolsSession(): void {
  showApproveDropdown.value = false
  agentStore.respondHITL(true, undefined, 'session', ['*'])
  resetState()
}

async function approveAll(): Promise<void> {
  showApproveDropdown.value = false
  if (!agentStore.pendingHITL) return
  const toolNames = agentStore.pendingHITL.toolCalls.map(tc => tc.name)
  await Promise.all(toolNames.map(name => agentStore.setToolApproval(name, true)))
  agentStore.respondHITL(true, undefined, 'always')
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
  showApproveDropdown.value = false
}

function hasLongArgs(args: string, limit = 250): boolean {
  return formatRichContent(args).markdown.length > limit
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
    class="hitl-request flex gap-4 px-4 py-3 justify-start"
  >
    <div class="relative shrink-0 mt-1">
      <div class="relative w-8 h-8 rounded-full flex items-center justify-center bg-amber-500/20 text-amber-500 border border-amber-500/30 shadow-sm">
        <Icon icon="mdi:warning-circle-outline" />
      </div>
    </div>

    <div class="hitl-card w-full max-w-[92%] rounded-xl border border-amber-500/30 bg-theme-800 shadow-lg shadow-black/20 overflow-hidden flex flex-col">
      <div class="hitl-card-header flex items-center justify-between gap-3 px-4 py-2.5 bg-amber-500/5 border-b border-theme-700/50">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-amber-500 tracking-wide uppercase text-[11px]">
            Action Required
          </div>
          <p class="hitl-card-description mt-0.5 text-xs text-theme-500">
            Review the requested tool actions before allowing them to run.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span
            v-if="agentStore.activeHITLQueue.length > 1"
            class="text-[10px] font-medium text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20"
            :title="`${agentStore.activeHITLQueue.length} approval requests queued for this chat`"
          >
            1 of {{ agentStore.activeHITLQueue.length }}
          </span>
          <span class="text-xs font-medium text-theme-400 bg-theme-900/50 px-2 py-0.5 rounded-full border border-theme-700/50">
            {{ agentStore.pendingHITL.toolCalls.length }} tool{{ agentStore.pendingHITL.toolCalls.length > 1 ? 's' : '' }} requested
          </span>
        </div>
      </div>

      <div class="hitl-card-body px-4 py-3 space-y-3">
        <div
          v-for="(tc, i) in agentStore.pendingHITL.toolCalls"
          :key="i"
          class="hitl-tool-card flex flex-col gap-1.5 rounded-lg border p-2.5 border-theme-700/50 bg-theme-900/25"
          :class="toolCardClass(tc)"
          :data-tool-effect="toolEffect(tc)"
        >
          <div class="flex items-center justify-between">
            <span class="hitl-tool-name inline-flex items-center gap-1.5 rounded-md bg-accent-500/10 border border-accent-500/20 px-2 py-0.5 text-[11px] text-accent-400 font-mono font-medium">
              <Icon
                icon="lucide:wrench"
                class="h-3 w-3 text-accent-500/70"
              />{{ tc.name }}
            </span>
            <div class="flex items-center gap-2">
              <span
                class="hitl-tool-effect rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                :class="toolEffectBadgeClass(tc)"
              >{{ toolEffectLabel(tc) }}</span>
              <button
                v-if="hasLongArgs(tc.arguments)"
                class="text-[10px] font-medium text-theme-500 hover:text-theme-300 transition-colors uppercase tracking-wider"
                @click="toggleExpand(i)"
              >
                {{ expandedArgs.has(i) ? 'Show Less' : 'Show More' }}
              </button>
            </div>
          </div>
          
          <RichContent
            v-if="tc.arguments"
            :content="tc.arguments"
            class="hitl-arguments custom-scrollbar mt-0.5 rounded-lg border border-theme-700/50 bg-theme-950/50 p-2.5 text-[11px] shadow-inner"
            :class="expandedArgs.has(i) ? 'max-h-96' : 'max-h-40'"
          />
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
            class="w-full rounded-lg border border-theme-600 bg-theme-900 px-3 py-2 text-xs text-theme-100 placeholder-theme-500 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none transition-all shadow-inner"
            autofocus
            @keydown.enter="deny"
            @keydown.escape="cancelDeny"
          >
        </div>
      </Transition>

      <div class="hitl-card-footer flex items-center justify-end gap-2 px-4 py-2.5 border-t border-theme-700/50 bg-theme-800/80">
        <button
          v-if="showReasonInput"
          class="rounded-lg px-3 py-1.5 text-xs font-medium text-theme-400 hover:text-theme-100 hover:bg-theme-700/50 transition-all focus:outline-none focus:ring-2 focus:ring-theme-500"
          @click="cancelDeny"
        >
          Cancel
        </button>
        <button
          class="rounded-lg px-4 py-1.5 text-xs font-semibold transition-all focus:outline-none focus:ring-2"
          :class="showReasonInput 
            ? 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 focus:ring-red-500' 
            : 'bg-theme-700/50 text-theme-300 border border-theme-600/50 hover:bg-theme-700 hover:text-white focus:ring-theme-500'"
          @click="deny"
        >
          {{ showReasonInput ? 'Confirm Deny' : 'Deny Request' }}
        </button>
        <!-- Split Allow button with dropdown -->
        <div
          v-if="!showReasonInput"
          class="relative"
        >
          <div class="flex items-center rounded-lg bg-emerald-600 border border-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/20 overflow-hidden">
            <button
              class="px-4 py-1.5 text-xs font-semibold text-white dark:text-emerald-400 hover:bg-emerald-700 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-300 transition-all focus:outline-none"
              @click="approve"
            >
              Allow
            </button>
            <span class="w-px h-4 bg-white/30 dark:bg-emerald-500/20 self-center shrink-0" />
            <button
              class="px-1.5 py-1.5 text-white dark:text-emerald-400 hover:bg-emerald-700 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-300 transition-all focus:outline-none"
              @click.stop="showApproveDropdown = !showApproveDropdown"
            >
              <Icon
                icon="mdi:chevron-down"
                class="w-3.5 h-3.5 transition-transform"
                :class="showApproveDropdown ? 'rotate-180' : ''"
              />
            </button>
          </div>
          <!-- Dropdown menu -->
          <div
            v-if="showApproveDropdown"
            class="absolute right-0 bottom-full mb-1 w-52 rounded-lg border border-theme-700 bg-theme-800 shadow-lg shadow-black/40 overflow-hidden z-50"
          >
            <button
              class="w-full text-left px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors"
              @click="approveSession"
            >
              Allow in this Session
            </button>
            <button
              class="w-full text-left px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors border-t border-theme-700/50"
              @click="approveAll"
            >
              {{ approveAllLabel }}
            </button>

            <!--Separator-->
            <span class="block h-px bg-theme-600 my-1" />
            <button
              class="w-full text-left px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors border-t border-theme-700/50"
              @click="approveAllToolsSession"
            >
              Allow All Tools in this Session
            </button>
          </div>
          <!-- Backdrop to close dropdown -->
          <div
            v-if="showApproveDropdown"
            class="fixed inset-0 z-40"
            @click="showApproveDropdown = false"
          />
        </div>
      </div>
    </div>
  </div>
</template>
