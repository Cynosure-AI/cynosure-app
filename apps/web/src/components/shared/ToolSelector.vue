<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAgentStore, type ToolInfo, type ToolNamespace } from '../../stores/agent-runtime.store'
import { Icon } from '@iconify/vue'

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    showApprovals?: boolean
    scrollable?: boolean
  }>(),
  { showApprovals: false, scrollable: true }
)

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const agentStore = useAgentStore()

const toolFilterText = ref('')
const expandedNamespaces = ref<Set<string>>(new Set())

const selectedSet = computed(() => new Set(props.modelValue))

/**
 * Composite key uniquely identifies a tool across namespaces.
 * Format matches the server-side ToolRegistry composite key: "namespaceId::toolName"
 */
function toolKey(tool: ToolInfo): string {
  return tool.key
}

function isSelected(tool: ToolInfo): boolean {
  return selectedSet.value.has(toolKey(tool))
}

function toggleTool(tool: ToolInfo): void {
  const key = toolKey(tool)
  if (isSelected(tool)) {
    emit('update:modelValue', props.modelValue.filter((n) => n !== key))
  } else {
    emit('update:modelValue', [...props.modelValue, key])
  }
}

function selectAllTools(): void {
  emit('update:modelValue', agentStore.availableTools.map((t) => toolKey(t)))
}

function clearAllTools(): void {
  emit('update:modelValue', [])
}

const filteredTools = computed(() => {
  const query = toolFilterText.value.trim().toLowerCase()
  if (!query) return agentStore.availableTools
  return agentStore.availableTools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(query) ||
      tool.description.toLowerCase().includes(query) ||
      tool.namespace.label.toLowerCase().includes(query)
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
    if (!groups.has(key)) {
      groups.set(key, { namespace: tool.namespace, tools: [] })
    }
    groups.get(key)!.tools.push(tool)
  }
  return Array.from(groups.values()).sort((a, b) => {
    // Built-in tools always appear first
    if (a.namespace.id === 'builtin' && b.namespace.id !== 'builtin') return -1
    if (a.namespace.id !== 'builtin' && b.namespace.id === 'builtin') return 1
    return a.namespace.label.localeCompare(b.namespace.label)
  })
})

function displayToolName(tool: ToolInfo): string {
  return tool.name
}

function approvalName(tool: ToolInfo): string {
  return tool.executionName
}

function displayToolDescription(tool: ToolInfo): string {
  return tool.description.replace(/^\[MCP:\s*[^\]]*\]\s*/, '')
}

function toggleNamespace(group: NamespaceGroup): void {
  const allSelected = isNamespaceAllSelected(group)
  const current = new Set(props.modelValue)
  if (allSelected) {
    for (const tool of group.tools) current.delete(toolKey(tool))
  } else {
    for (const tool of group.tools) current.add(toolKey(tool))
  }
  emit('update:modelValue', Array.from(current))
}

function isNamespaceAllSelected(group: NamespaceGroup): boolean {
  return group.tools.length > 0 && group.tools.every((t) => isSelected(t))
}

function isNamespacePartiallySelected(group: NamespaceGroup): boolean {
  const selectedCount = group.tools.filter((t) => isSelected(t)).length
  return selectedCount > 0 && selectedCount < group.tools.length
}

function isNamespaceCollapsed(namespaceId: string): boolean {
  return !expandedNamespaces.value.has(namespaceId)
}

function toggleNamespaceCollapse(namespaceId: string): void {
  if (expandedNamespaces.value.has(namespaceId)) {
    expandedNamespaces.value.delete(namespaceId)
  } else {
    expandedNamespaces.value.add(namespaceId)
  }
}
</script>

<template>
  <div class="flex flex-col h-full rounded-xl border border-zinc-700 bg-zinc-800">
    <div class="flex items-center justify-between px-4 py-2.5 border-b border-zinc-700 shrink-0">
      <span class="text-[10px] text-zinc-500">
        {{ modelValue.length }}/{{ agentStore.availableTools.length }} enabled
      </span>
      <div class="flex items-center gap-3">
        <button
          class="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
          @click="selectAllTools"
        >
          Enable all
        </button>
        <button
          class="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
          @click="clearAllTools"
        >
          Disable all
        </button>
      </div>
    </div>

    <div class="px-4 py-2 border-b border-zinc-800 shrink-0">
      <input
        v-model="toolFilterText"
        type="text"
        placeholder="Search tools..."
        class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
    </div>

    <div :class="[scrollable ? 'overflow-y-auto min-h-0' : '', 'flex-1']">
      <div class="divide-y divide-zinc-800">
        <template
          v-for="group in groupedTools"
          :key="group.namespace.id"
        >
          <section class="relative">
            <div class="flex items-center gap-3 sticky top-0 z-10 bg-zinc-900/95 backdrop-blur-sm px-3 py-2 border-b border-zinc-800/50">
              <button
                class="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                @click="toggleNamespaceCollapse(group.namespace.id)"
              >
                <Icon
                  :icon="isNamespaceCollapsed(group.namespace.id) ? 'lucide:chevron-right' : 'lucide:chevron-down'"
                  class="w-4 h-4"
                />
              </button>
              <label
                class="flex items-center cursor-pointer"
                title="Toggle entire group"
              >
                <span
                  class="inline-flex items-center justify-center h-4 w-4 rounded border cursor-pointer"
                  :class="[
                    isNamespaceAllSelected(group)
                      ? 'bg-blue-600 border-blue-600'
                      : isNamespacePartiallySelected(group)
                        ? 'bg-blue-600 border-blue-600'
                        : 'border-zinc-500 bg-transparent'
                  ]"
                  @click="toggleNamespace(group)"
                >
                  <Icon
                    v-if="isNamespaceAllSelected(group)"
                    icon="lucide:check"
                    class="w-3 h-3 text-white"
                  />
                  <Icon
                    v-else-if="isNamespacePartiallySelected(group)"
                    icon="lucide:minus"
                    class="w-3 h-3 text-white"
                  />
                </span>
              </label>
              <div
                class="flex-1 cursor-pointer select-none"
                @click="toggleNamespaceCollapse(group.namespace.id)"
              >
                <p
                  class="text-[11px] uppercase tracking-wider font-semibold"
                  :class="group.namespace.id === 'builtin' ? 'text-blue-400' : 'text-purple-400'"
                >
                  {{ group.namespace.label }}
                </p>
                <p class="text-[10px] text-zinc-600 mt-0.5">
                  {{ group.tools.filter((t) => isSelected(t)).length }}/{{ group.tools.length }} selected
                </p>
              </div>
            </div>

            <div
              v-if="!isNamespaceCollapsed(group.namespace.id)"
              class="px-3 pb-3 mt-2 space-y-1 pl-11"
            >
              <label
                v-for="tool in group.tools"
                :key="toolKey(tool)"
                class="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-zinc-800/70 cursor-pointer"
                :title="displayToolDescription(tool)"
              >
                <div class="flex items-start gap-2 flex-1 min-w-0">
                  <input
                    type="checkbox"
                    class="mt-0.5 h-4 w-4 accent-blue-600 shrink-0"
                    :checked="isSelected(tool)"
                    @change="toggleTool(tool)"
                  >
                  <div class="min-w-0 flex-1">
                    <p class="text-xs text-zinc-200 font-medium">{{ displayToolName(tool) }}</p>
                    <p class="text-[10px] text-zinc-500 leading-snug wrap-break-word">
                      {{ displayToolDescription(tool) }}
                    </p>
                  </div>
                </div>
                
                <button
                  v-if="showApprovals"
                  class="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] transition-colors"
                  :class="
                    agentStore.isToolAutoApproved(approvalName(tool))
                      ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
                      : 'bg-amber-500/10 text-amber-400/80 hover:bg-amber-500/20'
                  "
                  :title="
                    agentStore.isToolAutoApproved(approvalName(tool))
                      ? 'Auto-approved — click to require confirmation'
                      : 'Requires confirmation — click to auto-approve'
                  "
                  @click.stop.prevent="agentStore.setToolApproval(approvalName(tool), !agentStore.isToolAutoApproved(approvalName(tool)))"
                >
                  <Icon
                    :icon="agentStore.isToolAutoApproved(approvalName(tool)) ? 'mdi:shield-check' : 'mdi:alert-outline'"
                    class="w-3 h-3"
                  />
                  {{ agentStore.isToolAutoApproved(approvalName(tool)) ? 'auto' : 'confirm' }}
                </button>
              </label>
            </div>
          </section>
        </template>

        <div
          v-if="filteredTools.length === 0"
          class="px-4 py-6 text-center text-xs text-zinc-500"
        >
          <template v-if="toolFilterText">
            No tools match "{{ toolFilterText }}"
          </template>
          <template v-else>
            No tools available. Configure MCP servers to add external tools.
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
