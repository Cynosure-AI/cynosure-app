<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAgentStore, type ToolCallDisplay } from '../../stores/agent-runtime.store'
import { useChatStore } from '../../stores/chat.store'
import { Icon } from '@iconify/vue'
import RichContent from '../shared/RichContent.vue'
import ClampedContent from '../shared/ClampedContent.vue'
import ToolNamespaceIcon from '../chat/ToolNamespaceIcon.vue'
import { useToolPresentation } from '../../composables/useToolPresentation'

const agentStore = useAgentStore()
const chatStore = useChatStore()
const { isBuiltInTool, toolDisplayName, toolNamespaceIcon, toolIconUrl } = useToolPresentation()
const denyReason = ref('')
const showReasonInput = ref(false)
const showApproveDropdown = ref(false)
const fileAccessCall = computed(() => agentStore.pendingHITL?.toolCalls.find(tc => tc.fileAccess))
const fileAccess = computed(() => fileAccessCall.value?.fileAccess)
type ToolEffect = 'destructive' | 'write' | 'read' | 'unknown'

function toolEffect(toolCall: ToolCallDisplay): ToolEffect {
  // The shell tool is annotated destructive as a whole; use the server's review of this command.
  if (toolCall.shell) return toolCall.shell.readOnly ? 'read' : 'write'
  if (toolCall.annotations?.destructiveHint === true) return 'destructive'
  if (toolCall.annotations?.readOnlyHint === false) return 'write'
  if (toolCall.annotations?.readOnlyHint === true) return 'read'
  return 'unknown'
}

function toolEffectLabel(toolCall: ToolCallDisplay): string {
  if (toolCall.shell) return toolCall.shell.readOnly ? 'Read-only' : 'Not read-only'
  const effect = toolEffect(toolCall)
  return effect === 'unknown' ? 'Unclassified' : effect[0].toUpperCase() + effect.slice(1)
}

function toolEffectBadgeClass(toolCall: ToolCallDisplay): string {
  const effect = toolEffect(toolCall)
  if (effect === 'destructive') return 'border-red-500/30 bg-red-500/10 text-red-400'
  if (effect === 'write') return 'border-amber-500/30 bg-amber-500/10 text-amber-400'
  if (effect === 'read') return 'border-sky-500/30 bg-sky-500/10 text-sky-400'
  return 'border-theme-700/60 bg-theme-900/60 text-ink-muted'
}

const approveAllLabel = computed(() => {
  const names = [...new Set(agentStore.pendingHITL?.toolCalls.map(tc => tc.name) ?? [])]
  return `Allow All (${names.join(', ')})`
})

function approve(): void {
  agentStore.respondHITL(true, undefined, 'once')
  resetState()
}

function denyFileAccess(): void {
  agentStore.respondHITL(false)
  resetState()
}

function approveSession(): void {
  showApproveDropdown.value = false
  agentStore.respondHITL(true, undefined, 'session')
  resetState()
}

function approveAllToolsSession(): void {
  showApproveDropdown.value = false
  // The server records this as the chat's full access mode.
  if (agentStore.pendingHITL?.conversationId === chatStore.activeConversationId) chatStore.permissionMode = 'full'
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
  showApproveDropdown.value = false
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
          <p class="hitl-card-description mt-0.5 text-xs text-ink-muted">
            {{ fileAccess ? 'Allow this folder for AI file tools?' : 'Review the requested tool actions before allowing them to run.' }}
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
          <span
            v-if="!fileAccess && agentStore.pendingHITL.toolCalls.length > 1"
            class="text-[10px] font-medium text-ink-secondary bg-theme-900/50 px-2 py-0.5 rounded-full border border-theme-700/50"
          >
            {{ agentStore.pendingHITL.toolCalls.length }} tools
          </span>
        </div>
      </div>

      <div class="hitl-card-body divide-y divide-theme-700/40">
        <div
          v-if="fileAccess"
          class="space-y-2 px-4 py-3 text-sm text-theme-200"
        >
          <p><span class="text-ink-muted">Folder to allow recursively:</span></p>
          <p class="break-all rounded-lg border border-theme-700 bg-theme-950/50 p-2.5 font-mono text-xs">
            {{ fileAccess.folder }}
          </p>
          <p class="break-all text-xs text-ink-muted">
            {{ fileAccess.toolName }} requested {{ fileAccess.path }}
          </p>
          <p class="text-xs text-ink-muted">
            Requested action:
          </p>
          <div class="rounded-lg border border-theme-700/50 bg-theme-950/50 p-2.5 shadow-inner">
            <ClampedContent v-if="fileAccessCall?.arguments">
              <RichContent
                :content="fileAccessCall.arguments"
                class="hitl-arguments text-[11px]"
              />
            </ClampedContent>
          </div>
          <p class="text-xs text-ink-muted">
            Allowing adds this folder to Settings → File Access and lets this tool call proceed. You can remove the folder there later.
          </p>
        </div>
        <div
          v-for="(tc, i) in agentStore.pendingHITL.toolCalls"
          v-show="!fileAccess"
          :key="`${agentStore.pendingHITL.taskId}-${i}`"
          class="hitl-tool-card flex flex-col gap-2.5 px-4 py-3"
          :data-tool-effect="toolEffect(tc)"
        >
          <div class="flex min-w-0 items-center gap-2.5">
            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
              :class="isBuiltInTool(tc.name) ? 'bg-theme-700/45 text-theme-200' : 'bg-accent-500/10 text-accent-fg'"
            >
              <ToolNamespaceIcon
                :src="toolIconUrl(tc.name)"
                :icon="toolNamespaceIcon(tc.name)"
                icon-class="h-3.5 w-3.5"
                class="h-4 w-4"
              />
            </span>
            <span
              class="hitl-tool-name min-w-0 flex-1 truncate text-[13px] font-medium"
              :class="isBuiltInTool(tc.name) ? 'text-theme-200' : 'text-accent-fg'"
              :title="tc.name"
            >{{ toolDisplayName(tc.name) }}</span>
            <span
              class="hitl-tool-effect shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              :class="toolEffectBadgeClass(tc)"
            >{{ toolEffectLabel(tc) }}</span>
          </div>

          <template v-if="tc.shell">
            <div class="rounded-lg border border-status-warning/30 bg-status-warning/10 px-2.5 py-2">
              <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-status-warning">
                Command purpose
              </p>
              <p
                class="hitl-shell-explanation break-words text-sm leading-relaxed"
                :class="tc.shell.explanation ? 'font-semibold text-theme-100' : 'italic text-ink-muted'"
              >
                {{ tc.shell.explanation || 'No explanation was given for this command.' }}
              </p>
            </div>
            <div class="hitl-shell overflow-hidden rounded-lg border border-theme-700/50 bg-theme-950/50 shadow-inner">
              <div
                v-if="tc.shell.cwd"
                class="flex items-center gap-1.5 border-b border-theme-700/40 px-2.5 py-1 text-[10px] text-ink-muted"
              >
                <Icon
                  icon="lucide:folder"
                  class="h-3 w-3 shrink-0"
                />
                <span
                  class="truncate font-mono"
                  :title="tc.shell.cwd"
                >{{ tc.shell.cwd }}</span>
              </div>
              <ClampedContent class="px-2.5 py-2">
                <pre class="hitl-shell-command whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-theme-200"><span
                  class="select-none text-ink-faint"
                  aria-hidden="true"
                >$ </span>{{ tc.shell.command }}</pre>
              </ClampedContent>
            </div>
            <div
              v-if="tc.shell.reasons.length"
              class="hitl-shell-reasons rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2"
            >
              <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-500/90">
                Needs approval because
              </p>
              <ul class="space-y-0.5 text-[11px] text-amber-400">
                <li
                  v-for="reason in tc.shell.reasons"
                  :key="reason"
                  class="flex items-start gap-1.5"
                >
                  <Icon
                    icon="lucide:shield-alert"
                    class="mt-0.5 h-3 w-3 shrink-0"
                  />{{ reason }}
                </li>
              </ul>
            </div>
          </template>
          <div
            v-else-if="tc.arguments"
            class="rounded-lg border border-theme-700/50 bg-theme-950/50 px-2.5 py-2 shadow-inner"
          >
            <ClampedContent>
              <RichContent
                :content="tc.arguments"
                class="hitl-arguments text-[11px]"
              />
            </ClampedContent>
          </div>
        </div>
      </div>

      <Transition name="slide-down">
        <div
          v-if="showReasonInput && !fileAccess"
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
        <template v-if="fileAccess">
          <button
            class="rounded-lg border border-theme-600 px-4 py-1.5 text-xs font-semibold text-theme-300 hover:bg-theme-700"
            @click="denyFileAccess"
          >
            Deny
          </button>
          <button
            class="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            @click="approve"
          >
            Allow folder and run
          </button>
        </template>
        <template v-else>
          <button
            v-if="showReasonInput"
            class="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-theme-100 hover:bg-theme-700/50 transition-all focus:outline-none focus:ring-2 focus:ring-theme-500"
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
                class="px-4 py-1.5 text-xs font-semibold text-white dark:text-emerald-400 hover:bg-emerald-700 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-300 transition-all focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
                @click="approve"
              >
                Allow
              </button>
              <span class="w-px h-4 bg-white/30 dark:bg-emerald-500/20 self-center shrink-0" />
              <button
                class="px-1.5 py-1.5 text-white dark:text-emerald-400 hover:bg-emerald-700 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-300 transition-all focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
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
        </template>
      </div>
    </div>
  </div>
</template>
