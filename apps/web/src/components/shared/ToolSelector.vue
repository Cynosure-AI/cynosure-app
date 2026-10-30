<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAgentStore, type ToolInfo, type ToolNamespace } from '../../stores/agent-runtime.store'
import { useMcpServers } from '../../composables/useMcpServers'
import { Icon } from '@iconify/vue'
import CollapsibleSection from './CollapsibleSection.vue'
import HoverTooltip from './HoverTooltip.vue'
import ToolBehaviorBadges from './ToolBehaviorBadges.vue'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId } from '../../utils/internal-tools'
import { getToolNamespaceIcon } from '../../utils/tool-namespace-icons'

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
const { servers, loadServers } = useMcpServers()

const toolFilterText = ref('')
const brokenIcons = ref<Set<string>>(new Set())
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
  if (!isBuiltInNamespaceId(tool.namespace.id)) return false
  return isAutoManagedBuiltInToolName(tool.name)
}

function toolRequirement(tool: ToolInfo): { met: boolean; criteria: string } | undefined {
  if (!isBuiltInNamespaceId(tool.namespace.id)) return undefined
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
  if (toolName.startsWith('attachment_')) return 'large indexed attachment available'
  if (toolName === 'expand_available_toolset') return 'auto tool mode enabled'
  if (toolName === 'spawn_subagent' || toolName === 'continue_subagent') return 'sub-agent selected'
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
    if (isBuiltInNamespaceId(a.namespace.id) && !isBuiltInNamespaceId(b.namespace.id)) return -1
    if (!isBuiltInNamespaceId(a.namespace.id) && isBuiltInNamespaceId(b.namespace.id)) return 1
    return a.namespace.label.localeCompare(b.namespace.label)
  })
})

function displayToolName(tool: ToolInfo): string {
  return tool.name
}

function namespaceIcon(namespaceId: string): string | null {
  if (!namespaceId.startsWith('mcp:') || brokenIcons.value.has(namespaceId)) return null
  return servers.value.find((server) => server.id === namespaceId.slice(4))?.icon_url ?? null
}

function markIconBroken(namespaceId: string): void {
  brokenIcons.value = new Set([...brokenIcons.value, namespaceId])
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

onMounted(() => {
  if (servers.value.length === 0) void loadServers().catch(() => undefined)
})
</script>

<template>
  <div
    class="flex min-w-0 flex-col rounded-xl border border-theme-700 bg-theme-800"
    :class="scrollable ? 'h-full' : ''"
  >
    <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-theme-700 shrink-0">
      <span class="text-sm font-medium text-ink-secondary">
        {{ modelValue.length }}/{{ selectableToolCount }} enabled
      </span>
      <div class="flex items-center gap-3">
        <button
          class="rounded py-1 text-xs font-medium text-accent-fg hover:text-accent-fg transition-colors"
          @click="selectAllTools"
        >
          Enable all
        </button>
        <button
          class="rounded py-1 text-xs font-medium text-ink-secondary hover:text-theme-200 transition-colors"
          @click="clearAllTools"
        >
          Disable all
        </button>
      </div>
    </div>

    <div class="border-b border-theme-700 px-4 py-3 shrink-0">
      <label class="flex items-center gap-2.5 rounded-lg border border-theme-600 bg-theme-900 px-3 py-2.5 focus-within:border-accent-500 focus-within:ring-1 focus-within:ring-accent-500">
        <Icon
          icon="lucide:search"
          class="h-4 w-4 shrink-0 text-ink-muted"
        />
        <input
          v-model="toolFilterText"
          type="search"
          placeholder="Search tools and MCP servers…"
          aria-label="Search tools and MCP servers"
          class="min-w-0 w-full bg-transparent text-sm text-theme-200 placeholder:text-ink-muted focus:outline-none"
        >
      </label>
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
              <template #trigger="{ expanded, toggle, triggerAttrs }">
                <div
                  class="flex min-w-0 items-center gap-2 bg-theme-900/95 px-3 py-3 backdrop-blur-sm border-b border-theme-800/50 sm:gap-3 sm:px-4"
                  :class="scrollable ? 'sticky top-0 z-10' : ''"
                >
                  <button
                    v-bind="triggerAttrs"
                    :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${group.namespace.label}`"
                    class="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-theme-700 hover:text-theme-200 transition-colors"
                    @click="toggle"
                  >
                    <Icon
                      :icon="expanded ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                      class="w-4 h-4"
                    />
                  </button>
                  <button
                    type="button"
                    role="checkbox"
                    :aria-checked="isNamespacePartiallySelected(group) ? 'mixed' : isNamespaceAllSelected(group)"
                    :aria-label="`Toggle all ${group.namespace.label} tools`"
                    :disabled="selectableCount(group) === 0"
                    class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed"
                    :class="isNamespaceAllSelected(group) || isNamespacePartiallySelected(group)
                      ? 'bg-accent-600 border-accent-600'
                      : 'border-theme-500 bg-theme-800 hover:border-accent-500 disabled:border-theme-700'"
                    @click="toggleNamespace(group)"
                  >
                    <Icon
                      v-if="isNamespaceAllSelected(group) || isNamespacePartiallySelected(group)"
                      :icon="isNamespaceAllSelected(group) ? 'lucide:check' : 'lucide:minus'"
                      class="h-3.5 w-3.5 text-white"
                    />
                  </button>
                  <div
                    class="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-3"
                    @click="toggle"
                  >
                    <span class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-theme-800">
                      <img
                        v-if="namespaceIcon(group.namespace.id)"
                        :src="namespaceIcon(group.namespace.id)!"
                        alt=""
                        class="h-7 w-7 object-contain"
                        @error="markIconBroken(group.namespace.id)"
                      >
                      <Icon
                        v-else
                        :icon="getToolNamespaceIcon(group.namespace.id)"
                        class="h-5 w-5 text-ink-secondary"
                      />
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                      <p
                        class="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]"
                        :class="isBuiltInNamespaceId(group.namespace.id) ? 'text-accent-fg' : 'text-theme-200'"
                      >
                        {{ group.namespace.label }}
                      </p>
                      <p class="shrink-0 text-xs text-ink-secondary sm:ml-auto">
                        {{ selectedCount(group) }}/{{ selectableCount(group) }} selected
                        <span v-if="autoManagedCount(group)"> · {{ autoManagedCount(group) }} automatic</span>
                        <span v-if="unavailableCount(group)"> · {{ unavailableCount(group) }} require agent</span>
                      </p>
                    </div>
                  </div>
                </div>
              </template>

              <div class="space-y-1 bg-theme-900/40 px-3 py-3 sm:pl-14">
                <label
                  v-for="tool in group.tools"
                  :key="toolKey(tool)"
                  class="flex flex-col items-stretch gap-3 rounded-lg px-3 py-3 sm:flex-row sm:items-center"
                  :class="isToolDisabled(tool) ? 'cursor-not-allowed opacity-55' : 'hover:bg-theme-800/70 cursor-pointer'"
                >
                  <div class="flex min-w-0 flex-1 items-start gap-3">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-5 w-5 accent-accent-600 shrink-0"
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
                        <p class="break-words text-sm font-medium text-theme-200 [overflow-wrap:anywhere]">
                          {{ displayToolName(tool) }}
                          <span
                            v-if="isAutoManagedTool(tool)"
                            class="ml-1 rounded bg-theme-700 px-1 py-0.5 text-[11px] font-normal text-ink-secondary"
                            :class="automaticToolState(tool).active ? 'bg-emerald-500/10 text-emerald-300' : ''"
                          >
                            {{ automaticToolBadge(tool) }}
                          </span>
                          <span
                            v-else-if="toolRequirement(tool)"
                            class="ml-1 rounded px-1 py-0.5 text-[11px] font-normal"
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
                          class="mb-2 rounded border  bg-theme-900/70 px-2 py-1.5 text-xs leading-relaxed pt-1.5 border-t border-theme-800"
                          :class="automaticToolState(tool).active ? 'text-emerald-300' : 'text-ink-secondary'"
                        >
                          {{ automaticToolState(tool).active ? 'Active' : 'Inactive' }} automatically when {{ automaticToolState(tool).criteria }}.
                        </div>
                        <div
                          v-else-if="toolRequirement(tool)"
                          class="mb-2 rounded border bg-theme-900/70 px-2 py-1.5 text-xs leading-relaxed"
                          :class="toolRequirement(tool)?.met ? 'border-emerald-500/20 text-emerald-300' : 'border-amber-500/20 text-amber-300'"
                        >
                          {{ toolRequirement(tool)?.met ? 'Requirement met' : 'Unavailable' }}: {{ toolRequirement(tool)?.criteria }}.
                        </div>
                        <div
                          class=" text-ink-secondary leading-snug"
                          :class="toolParams(tool).length || isAutoManagedTool(tool) ? '' : ''"
                        >
                          {{ displayToolDescription(tool) }}
                        </div>
                      </template>
                    </HoverTooltip>
                  </div>

                  <button
                    v-if="showApprovals"
                    class="flex shrink-0 items-center gap-1.5 self-end rounded-md px-2.5 py-1.5 text-xs transition-colors sm:self-auto"
                    :class="
                      agentStore.isToolAutoApproved(approvalName(tool))
                        ? 'bg-green-500/15 text-status-green hover:bg-green-500/25'
                        : 'bg-amber-500/10 text-status-warning/80 hover:bg-amber-500/20'
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
          class="px-4 py-8 text-center text-sm text-ink-muted"
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
