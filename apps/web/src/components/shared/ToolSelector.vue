<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAgentStore, type ToolInfo, type ToolNamespace } from '../../stores/agent-runtime.store'
import { Icon } from '@iconify/vue'
import CollapsibleSection from './CollapsibleSection.vue'
import HoverTooltip from './HoverTooltip.vue'
import ToolBehaviorBadges from './ToolBehaviorBadges.vue'
import { isAutoManagedBuiltInToolName } from '../../utils/internal-tools'

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    showApprovals?: boolean
    scrollable?: boolean
    automaticToolStates?: Record<string, { active: boolean; criteria: string }>
    toolRequirements?: Record<string, { met: boolean; criteria: string }>
  }>(),
  { showApprovals: false, scrollable: true, automaticToolStates: () => ({}), toolRequirements: () => ({}) }
)

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const agentStore = useAgentStore()

const toolFilterText = ref('')
const expandedNamespaces = ref<Set<string>>(new Set())
const debouncedSearchExpansion = ref(false)
let searchExpansionTimer: number | undefined

const selectedSet = computed(() => new Set(props.modelValue))
const selectableToolCount = computed(() => selectableTools(agentStore.availableTools).length)

/**
 * Composite key uniquely identifies a tool across namespaces.
 * Format matches the server-side ToolRegistry composite key: "namespaceId::toolName"
 */
function toolKey(tool: ToolInfo): string {
  return tool.key
}

function isSelected(tool: ToolInfo): boolean {
  if (isAutoManagedTool(tool)) return automaticToolState(tool).active
  return selectedSet.value.has(toolKey(tool))
}

function isAutoManagedTool(tool: ToolInfo): boolean {
  if (tool.namespace.id !== 'builtin') return false
  if (isAutoManagedBuiltInToolName(tool.name)) return true
  return (tool.name.startsWith('knowledge_') || tool.name === 'knowledge_entity_merge') && automaticToolState(tool).active
}

function toolRequirement(tool: ToolInfo): { met: boolean; criteria: string } | undefined {
  if (tool.namespace.id !== 'builtin') return undefined
  return props.toolRequirements[tool.name]
}

function hasUnmetRequirement(tool: ToolInfo): boolean {
  return toolRequirement(tool)?.met === false
}

function isToolDisabled(tool: ToolInfo): boolean {
  return isAutoManagedTool(tool) || hasUnmetRequirement(tool)
}

function requirementBadge(tool: ToolInfo): string {
  return `requires: ${toolRequirement(tool)?.criteria || 'additional configuration'}`
}

function automaticToolState(tool: ToolInfo): { active: boolean; criteria: string } {
  return props.automaticToolStates[tool.name] ?? { active: false, criteria: automaticToolCriteria(tool.name) }
}

function automaticToolCriteria(toolName: string): string {
  if (toolName.startsWith('todo_')) return 'thinking mode and visible execution tools'
  if (toolName.startsWith('memory_')) return 'memory folder selected'
  if (toolName.startsWith('knowledge_') || toolName === 'knowledge_entity_merge') return 'memory folder selected'
  if (toolName.startsWith('attachment_')) return 'large indexed attachment available'
  if (toolName === 'expand_available_toolset') return 'auto tool mode enabled'
  if (toolName === 'spawn_subagent') return 'sub-agent selected'
  return 'runtime criteria met'
}

function automaticToolBadge(tool: ToolInfo): string {
  return `automatic: ${automaticToolState(tool).criteria}`
}

function selectableTools(tools: ToolInfo[]): ToolInfo[] {
  return tools.filter((tool) => !isAutoManagedTool(tool) && !hasUnmetRequirement(tool))
}

function toggleTool(tool: ToolInfo): void {
  if (isToolDisabled(tool)) return
  const key = toolKey(tool)
  if (isSelected(tool)) {
    emit('update:modelValue', props.modelValue.filter((n) => n !== key))
  } else {
    emit('update:modelValue', [...props.modelValue, key])
  }
}

function selectAllTools(): void {
  emit('update:modelValue', selectableTools(agentStore.availableTools).map((t) => toolKey(t)))
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

interface ToolParam {
  name: string
  type: string
  required: boolean
  description?: string
}

function toolParams(tool: ToolInfo): ToolParam[] {
  const schema = tool.parameters as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | undefined
  if (!schema?.properties) return []
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties).map(([name, def]) => ({
    name,
    type: def.type ?? 'any',
    required: required.has(name),
    description: def.description,
  }))
}

function toggleNamespace(group: NamespaceGroup): void {
  const allSelected = isNamespaceAllSelected(group)
  const current = new Set(props.modelValue)
  const tools = selectableTools(group.tools)
  if (allSelected) {
    for (const tool of tools) current.delete(toolKey(tool))
  } else {
    for (const tool of tools) current.add(toolKey(tool))
  }
  emit('update:modelValue', Array.from(current))
}

function isNamespaceAllSelected(group: NamespaceGroup): boolean {
  const tools = selectableTools(group.tools)
  return tools.length > 0 && tools.every((t) => isSelected(t))
}

function isNamespacePartiallySelected(group: NamespaceGroup): boolean {
  const tools = selectableTools(group.tools)
  const selectedCount = tools.filter((t) => isSelected(t)).length
  return selectedCount > 0 && selectedCount < tools.length
}

function selectedCount(group: NamespaceGroup): number {
  return selectableTools(group.tools).filter((t) => isSelected(t)).length
}

function selectableCount(group: NamespaceGroup): number {
  return selectableTools(group.tools).length
}

function autoManagedCount(group: NamespaceGroup): number {
  return group.tools.filter(isAutoManagedTool).length
}

function unavailableCount(group: NamespaceGroup): number {
  return group.tools.filter((tool) => !isAutoManagedTool(tool) && hasUnmetRequirement(tool)).length
}

function isNamespaceExpanded(namespaceId: string): boolean {
  return debouncedSearchExpansion.value || expandedNamespaces.value.has(namespaceId)
}

function setNamespaceExpanded(namespaceId: string, expanded: boolean): void {
  if (expanded) {
    expandedNamespaces.value.add(namespaceId)
  } else {
    expandedNamespaces.value.delete(namespaceId)
  }
}

watch(toolFilterText, (value) => {
  window.clearTimeout(searchExpansionTimer)
  if (!value.trim()) {
    debouncedSearchExpansion.value = false
    return
  }
  searchExpansionTimer = window.setTimeout(() => {
    debouncedSearchExpansion.value = true
  }, 150)
})

onBeforeUnmount(() => {
  window.clearTimeout(searchExpansionTimer)
})
</script>

<template>
  <div class="flex flex-col h-full rounded-xl border border-theme-700 bg-theme-800">
    <div class="flex items-center justify-between px-4 py-2.5 border-b border-theme-700 shrink-0">
      <span class="text-[10px] text-theme-500">
        {{ modelValue.length }}/{{ selectableToolCount }} enabled
      </span>
      <div class="flex items-center gap-3">
        <button
          class="text-[11px] text-accent-400 hover:text-accent-300 transition-colors"
          @click="selectAllTools"
        >
          Enable all
        </button>
        <button
          class="text-[11px] text-theme-400 hover:text-theme-200 transition-colors"
          @click="clearAllTools"
        >
          Disable all
        </button>
      </div>
    </div>

    <div class="px-4 py-2 border-b border-theme-800 shrink-0">
      <input
        v-model="toolFilterText"
        type="text"
        placeholder="Search tools..."
        class="w-full bg-theme-800 border border-theme-700 rounded-lg px-3 py-1.5 text-xs text-theme-200 placeholder-theme-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
      >
    </div>

    <div :class="[scrollable ? 'overflow-y-auto min-h-0' : '', 'flex-1']">
      <div class="divide-y divide-theme-800">
        <template
          v-for="group in groupedTools"
          :key="group.namespace.id"
        >
          <section class="relative">
            <CollapsibleSection
              :model-value="isNamespaceExpanded(group.namespace.id)"
              @update:model-value="setNamespaceExpanded(group.namespace.id, $event)"
            >
              <template #trigger="{ expanded, toggle }">
                <div class="flex items-center gap-3 sticky top-0 z-10 bg-theme-900/95 backdrop-blur-sm px-3 py-2 border-b border-theme-800/50">
                  <button
                    class="p-1 text-theme-500 hover:text-theme-300 transition-colors"
                    @click="toggle"
                  >
                    <Icon
                      :icon="expanded ? 'lucide:chevron-down' : 'lucide:chevron-right'"
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
                          ? 'bg-accent-600 border-accent-600'
                          : isNamespacePartiallySelected(group)
                            ? 'bg-accent-600 border-accent-600'
                            : selectableCount(group)
                              ? 'border-theme-500 bg-transparent'
                              : 'border-theme-700 bg-theme-800'
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
                    class="flex cursor-pointer select-none justify-between items-center flex-1 gap-2"
                    @click="toggle"
                  >
                    <p
                      class="text-[11px] uppercase tracking-wider "
                      :class="group.namespace.id === 'builtin' ? 'text-accent-400' : ''"
                    >
                      {{ group.namespace.label }}
                    </p>
                    <p class="text-[10px] text-theme-600 mt-0.5">
                      {{ selectedCount(group) }}/{{ selectableCount(group) }} selected
                      <span v-if="autoManagedCount(group)"> · {{ autoManagedCount(group) }} automatic</span>
                      <span v-if="unavailableCount(group)"> · {{ unavailableCount(group) }} require agent</span>
                    </p>
                  </div>
                </div>
              </template>

              <div class="px-3 pb-3 mt-2 space-y-1 pl-11">
                <label
                  v-for="tool in group.tools"
                  :key="toolKey(tool)"
                  class="flex items-center gap-2 rounded-lg px-2 py-2"
                  :class="isToolDisabled(tool) ? 'cursor-not-allowed opacity-55' : 'hover:bg-theme-800/70 cursor-pointer'"
                >
                  <div class="flex items-start gap-2 flex-1 min-w-0">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-4 w-4 accent-accent-600 shrink-0"
                      :checked="isSelected(tool)"
                      :disabled="isToolDisabled(tool)"
                      :title="isAutoManagedTool(tool) ? automaticToolBadge(tool) : hasUnmetRequirement(tool) ? requirementBadge(tool) : undefined"
                      @change="toggleTool(tool)"
                    >
                    <HoverTooltip
                      :block="true"
                      placement="mouse"
                      :max-width="260"
                    >
                      <div class="min-w-0 flex-1">
                        <p class="text-xs text-theme-200 font-medium">
                          {{ displayToolName(tool) }}
                          <span
                            v-if="isAutoManagedTool(tool)"
                            class="ml-1 rounded bg-theme-700 px-1 py-0.5 text-[9px] font-normal uppercase tracking-wide text-theme-400"
                            :class="automaticToolState(tool).active ? 'bg-emerald-500/10 text-emerald-300' : ''"
                          >
                            {{ automaticToolBadge(tool) }}
                          </span>
                          <span
                            v-else-if="toolRequirement(tool)"
                            class="ml-1 rounded px-1 py-0.5 text-[9px] font-normal uppercase tracking-wide"
                            :class="toolRequirement(tool)?.met ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'"
                          >
                            {{ requirementBadge(tool) }}
                          </span>
                        </p>
                        <ToolBehaviorBadges
                          :annotations="tool.annotations"
                          class="mt-1"
                        />
                      </div>
                      <template #content>
                        <div
                          v-if="isAutoManagedTool(tool)"
                          class="mb-2 rounded border  bg-theme-900/70 px-2 py-1.5 text-[10px] leading-snug pt-1.5 border-t border-theme-800"
                          :class="automaticToolState(tool).active ? 'text-emerald-300' : 'text-theme-400'"
                        >
                          {{ automaticToolState(tool).active ? 'Active' : 'Inactive' }} automatically when {{ automaticToolState(tool).criteria }}.
                        </div>
                        <div
                          v-else-if="toolRequirement(tool)"
                          class="mb-2 rounded border bg-theme-900/70 px-2 py-1.5 text-[10px] leading-snug"
                          :class="toolRequirement(tool)?.met ? 'border-emerald-500/20 text-emerald-300' : 'border-amber-500/20 text-amber-300'"
                        >
                          {{ toolRequirement(tool)?.met ? 'Requirement met' : 'Unavailable' }}: {{ toolRequirement(tool)?.criteria }}.
                        </div>
                        <div
                          class=" text-theme-400 leading-snug"
                          :class="toolParams(tool).length || isAutoManagedTool(tool) ? '' : ''"
                        >
                          {{ displayToolDescription(tool) }}
                        </div>
                      </template>
                    </HoverTooltip>
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
            </CollapsibleSection>
          </section>
        </template>

        <div
          v-if="filteredTools.length === 0"
          class="px-4 py-6 text-center text-xs text-theme-500"
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
