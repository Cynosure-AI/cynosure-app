<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAgentStore, type ToolInfo, type ToolNamespace } from '../../../stores/agent-runtime.store'
import { Icon } from '@iconify/vue'

const agentStore = useAgentStore()

const filterText = ref('')
const collapsedNamespaces = ref<Set<string>>(new Set())

const mcpTools = computed(() =>
  agentStore.availableTools.filter((t) => t.namespace.id.startsWith('mcp:'))
)

const filteredTools = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  if (!q) return mcpTools.value
  return mcpTools.value.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.namespace.label.toLowerCase().includes(q)
  )
})

interface NamespaceGroup {
  namespace: ToolNamespace
  tools: ToolInfo[]
}

const groupedTools = computed<NamespaceGroup[]>(() => {
  const groups = new Map<string, NamespaceGroup>()
  for (const tool of filteredTools.value) {
    const key = tool.namespace.id
    if (!groups.has(key)) groups.set(key, { namespace: tool.namespace, tools: [] })
    groups.get(key)!.tools.push(tool)
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.namespace.label.localeCompare(b.namespace.label)
  )
})

// Auto-collapse any namespace that appears for the first time
watch(
  groupedTools,
  (groups) => {
    for (const group of groups) {
      if (!collapsedNamespaces.value.has(group.namespace.id)) {
        collapsedNamespaces.value = new Set([...collapsedNamespaces.value, group.namespace.id])
      }
    }
  },
  { immediate: true }
)

function displayName(tool: ToolInfo): string {
  const dbl = tool.name.indexOf('__')
  return dbl !== -1 ? tool.name.slice(dbl + 2) : tool.name
}

function displayDescription(tool: ToolInfo): string {
  return tool.description.replace(/^\[MCP:\s*[^\]]*\]\s*/, '')
}

function isAutoApproved(name: string): boolean {
  return agentStore.isToolAutoApproved(name)
}

function approvalName(tool: ToolInfo): string {
  return tool.executionName
}

async function toggleApproval(name: string): Promise<void> {
  await agentStore.setToolApproval(name, !isAutoApproved(name))
}

async function setAllInNamespace(group: NamespaceGroup, autoApprove: boolean): Promise<void> {
  for (const tool of group.tools) {
    await agentStore.setToolApproval(approvalName(tool), autoApprove)
  }
}

const autoApprovedCount = computed(() =>
  mcpTools.value.filter((t) => isAutoApproved(approvalName(t))).length
)

async function confirmAll(): Promise<void> {
  for (const tool of mcpTools.value) {
    await agentStore.setToolApproval(approvalName(tool), true)
  }
}

async function askAll(): Promise<void> {
  for (const tool of mcpTools.value) {
    await agentStore.setToolApproval(approvalName(tool), false)
  }
}

function toggleCollapse(nsId: string): void {
  if (collapsedNamespaces.value.has(nsId)) collapsedNamespaces.value.delete(nsId)
  else collapsedNamespaces.value.add(nsId)
}
</script>

<template>
  <div class="flex flex-col overflow-hidden">
    <!-- Header bar -->
    <div class="flex items-center justify-between px-4 py-2.5 shrink-0">
      <span class="text-[10px] text-zinc-500">
        {{ autoApprovedCount }}/{{ mcpTools.length }} auto-confirmed
      </span>
      <div class="flex items-center gap-3">
        <button
          class="text-[11px] text-green-400 hover:text-green-300 transition-colors"
          @click="confirmAll"
        >
          Auto-confirm all
        </button>
        <button
          class="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
          @click="askAll"
        >
          Ask for all
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="px-4 py-2 border-t border-zinc-800 shrink-0">
      <input
        v-model="filterText"
        type="text"
        placeholder="Search tools..."
        class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
    </div>

    <!-- Tool list -->
    <div class="px-2 py-2 space-y-1 min-h-0 overflow-y-auto">
      <template
        v-for="group in groupedTools"
        :key="group.namespace.id"
      >
        <!-- Namespace header -->
        <div class="flex items-center gap-2 px-2 pt-2 pb-1">
          <button
            class="flex items-center gap-1.5 flex-1 text-left"
            @click="toggleCollapse(group.namespace.id)"
          >
            <Icon
              icon="mdi:chevron-down"
              class="h-3 w-3 text-zinc-500 transition-transform"
              :class="{ '-rotate-90': collapsedNamespaces.has(group.namespace.id) }"
            />
            <span class="text-[11px] uppercase tracking-wider font-semibold text-purple-400">
              {{ group.namespace.label }}
            </span>
            <span class="text-[10px] text-zinc-600">
              {{ group.tools.filter((t) => isAutoApproved(approvalName(t))).length }}/{{ group.tools.length }} auto
            </span>
          </button>

          <!-- Bulk toggle for this namespace -->
          <div class="flex items-center gap-1 shrink-0">
            <button
              class="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors"
              title="Auto-confirm all tools in this server"
              @click="setAllInNamespace(group, true)"
            >
              All auto
            </button>
            <button
              class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors"
              title="Ask for all tools in this server"
              @click="setAllInNamespace(group, false)"
            >
              All ask
            </button>
          </div>
        </div>

        <!-- Tools in namespace -->
        <div
          v-if="!collapsedNamespaces.has(group.namespace.id)"
          class="space-y-0.5 pl-2"
        >
          <div
            v-for="tool in group.tools"
            :key="tool.name"
            class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-zinc-800/60 transition-colors"
            :title="displayDescription(tool)"
          >
            <!-- Tool info -->
            <div class="flex-1 min-w-0">
              <span class="text-xs text-zinc-200 font-medium block">{{ displayName(tool) }}</span>
              <p class="text-[10px] text-zinc-500 leading-snug truncate">
                {{ displayDescription(tool) }}
              </p>
            </div>

            <!-- HITL toggle -->
            <button
              class="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors"
              :class="
                isAutoApproved(approvalName(tool))
                  ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
                  : 'bg-amber-500/10 text-amber-400/80 hover:bg-amber-500/20'
              "
              :title="
                isAutoApproved(approvalName(tool))
                  ? 'Auto-confirmed — click to require approval'
                  : 'Requires approval — click to auto-confirm'
              "
              @click="toggleApproval(approvalName(tool))"
            >
              <Icon
                :icon="isAutoApproved(approvalName(tool)) ? 'mdi:shield-check' : 'mdi:alert-outline'"
                class="w-3 h-3"
              />
              {{ isAutoApproved(approvalName(tool)) ? 'auto' : 'ask' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Empty state -->
      <div
        v-if="filteredTools.length === 0"
        class="px-4 py-8 text-center text-xs text-zinc-500"
      >
        <template v-if="filterText">
          No tools match "{{ filterText }}"
        </template>
        <template v-else>
          No MCP tools registered. Connect and enable an MCP server first.
        </template>
      </div>
    </div>
  </div>
</template>
