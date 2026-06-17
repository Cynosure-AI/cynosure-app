<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../api/client'
import { useAgentStore, type ToolInfo, type ToolNamespace } from '../stores/agent-runtime.store.ts'
import DataTable, { type Column } from '../components/shared/DataTable.vue'
import HoverTooltip from '../components/shared/HoverTooltip.vue'

interface NamespaceGroup {
  id: string
  namespace: ToolNamespace
  description: string
  tools: ToolInfo[]
}

interface ToolParam {
  name: string
  type: string
  required: boolean
  description?: string
  children?: ToolParam[]
}

interface ToolParamSchema {
  type?: unknown
  enum?: unknown[]
  items?: { type?: unknown }
  description?: string
  properties?: Record<string, ToolParamSchema>
  required?: string[]
}

const agentStore = useAgentStore()
const tools = ref<ToolInfo[]>([])
const filterText = ref('')
const expandedGroupIds = ref<Set<string>>(new Set())
const loading = ref(true)

const columns: Column<NamespaceGroup>[] = [
  {
    key: 'category',
    label: 'MCP / Category',
    width: 'minmax(280px, 1.8fr)',
    sortable: true,
    sortValue: (group) => group.namespace.label,
  },
  {
    key: 'state',
    label: 'Selected State',
    width: '190px',
    class: 'text-right',
    sortable: true,
    sortValue: (group) => namespaceApprovalSort(group),
  },
]

const filteredTools = computed(() => {
  const query = filterText.value.trim().toLowerCase()
  if (!query) return tools.value

  return tools.value.filter((tool) =>
    tool.name.toLowerCase().includes(query) ||
    displayDescription(tool).toLowerCase().includes(query) ||
    tool.namespace.label.toLowerCase().includes(query) ||
    toolCategory(tool).toLowerCase().includes(query)
  )
})

const groupedTools = computed<NamespaceGroup[]>(() => {
  const groups = new Map<string, NamespaceGroup>()

  for (const tool of filteredTools.value) {
    const namespace = normalizeNamespace(tool.namespace, tool)
    if (!groups.has(namespace.id)) {
      groups.set(namespace.id, {
        id: namespace.id,
        namespace,
        description: namespaceDescription(namespace, tool),
        tools: [],
      })
    }
    groups.get(namespace.id)!.tools.push(tool)
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      tools: [...group.tools].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    }))
    .sort((a, b) => {
      const rank = (ns: string) => (ns === 'builtin' ? 0 : ns === 'builtin:internal' ? 1 : 2)
      const ra = rank(a.namespace.id), rb = rank(b.namespace.id)
      return ra !== rb ? ra - rb : a.namespace.label.localeCompare(b.namespace.label)
    })
})

const autoApprovedCount = computed(() =>
  tools.value.filter((tool) => isAutoApproved(approvalName(tool))).length
)

function isInternalTool(tool: ToolInfo): boolean {
  const name = tool.name
  return name.startsWith('orchestrator_') || name.startsWith('attachment_') || name.startsWith('memory_') || name.startsWith('entity_graph_') || name === 'forget_memory' || name === 'expand_available_toolset' || name === 'spawn_subagent'
}

function normalizeNamespace(namespace: ToolNamespace, tool?: ToolInfo): ToolNamespace {
  if (namespace.id === 'builtin') {
    if (tool && isInternalTool(tool)) return { id: 'builtin:internal', label: 'Internal' }
    return { ...namespace, label: 'Built-In' }
  }
  return namespace
}

function namespaceDescription(namespace: ToolNamespace, firstTool: ToolInfo): string {
  if (namespace.id === 'builtin:internal') {
    return 'Orchestration, attachments, tool routing, sub-agent delegation, memory, and other system-managed tools. These are always auto-approved.'
  }
  if (namespace.id === 'builtin') {
    return 'All built-in on-demand tools bundled with Cynosure.'
  }
  return displayDescription(firstTool)
}

function displayName(tool: ToolInfo): string {
  const dbl = tool.name.indexOf('__')
  return dbl !== -1 ? tool.name.slice(dbl + 2) : tool.name
}

function displayDescription(tool: ToolInfo): string {
  return tool.description.replace(/^\[MCP:\s*[^\]]*\]\s*/, '')
}

function approvalName(tool: ToolInfo): string {
  return tool.executionName
}

function isAutoApproved(name: string): boolean {
  return agentStore.isToolAutoApproved(name)
}

function namespaceAutoApprovedCount(group: NamespaceGroup): number {
  return group.tools.filter((tool) => isAutoApproved(approvalName(tool))).length
}

function namespaceApprovalState(group: NamespaceGroup): 'all' | 'none' | 'partial' {
  const autoCount = namespaceAutoApprovedCount(group)
  if (autoCount === 0) return 'none'
  if (autoCount === group.tools.length) return 'all'
  return 'partial'
}

function namespaceApprovalSort(group: NamespaceGroup): number {
  const state = namespaceApprovalState(group)
  if (state === 'all') return 2
  if (state === 'partial') return 1
  return 0
}

function namespaceApprovalLabel(group: NamespaceGroup): string {
  const state = namespaceApprovalState(group)
  if (state === 'all') return 'all auto'
  if (state === 'none') return 'all ask'
  return 'mixed'
}

function stateIcon(state: 'all' | 'none' | 'partial'): string {
  if (state === 'all') return 'lucide:shield-check'
  if (state === 'none') return 'lucide:shield-alert'
  return 'lucide:shield'
}

function stateClass(state: 'all' | 'none' | 'partial'): string {
  if (state === 'all') return 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
  if (state === 'none') return 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
  return 'bg-accent-500/15 text-accent-300 hover:bg-accent-500/25'
}

function toolCategory(tool: ToolInfo): string {
  const name = tool.name
  if (tool.namespace.id.startsWith('mcp:')) return 'MCP'
  if (name.startsWith('memory_') || name === 'forget_memory') return 'Memory'
  if (name.startsWith('entity_graph_')) return 'Entity'
  if (name.startsWith('orchestrator_')) return 'Orchestration'
  if (name.startsWith('attachment_')) return 'Attachment'
  return 'Built-In'
}

function toolParams(tool: ToolInfo): ToolParam[] {
  const schema = tool.parameters as { properties?: Record<string, ToolParamSchema>; required?: string[] } | undefined
  if (!schema?.properties) return []

  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties).map(([name, def]) => ({
    name,
    type: paramType(def),
    required: required.has(name),
    description: def.description,
    children: nestedParams(def),
  }))
}

function nestedParams(def: ToolParamSchema): ToolParam[] | undefined {
  if (!def.properties) return undefined
  const required = new Set(def.required ?? [])
  return Object.entries(def.properties).map(([name, child]) => ({
    name,
    type: paramType(child),
    required: required.has(name),
    description: child.description,
    children: nestedParams(child),
  }))
}

function paramType(def: { type?: unknown; enum?: unknown[]; items?: { type?: unknown } }): string {
  if (Array.isArray(def.enum) && def.enum.length) return def.enum.map(String).join(' | ')
  if (def.type === 'array') return `${String(def.items?.type ?? 'any')}[]`
  return typeof def.type === 'string' ? def.type : 'any'
}

function paramDescription(param: ToolParam): string | undefined {
  const childLines = param.children?.length
    ? param.children.map((child) => `${child.name}: ${child.type}${child.required ? '' : '?'}${child.description ? ` - ${child.description}` : ''}`)
    : []
  return [param.description, ...childLines].filter(Boolean).join('\n') || undefined
}

function isExpanded(groupId: string): boolean {
  return expandedGroupIds.value.has(groupId)
}

function toggleExpanded(group: NamespaceGroup): void {
  const next = new Set(expandedGroupIds.value)
  if (next.has(group.id)) next.delete(group.id)
  else next.add(group.id)
  expandedGroupIds.value = next
}

async function toggleApproval(name: string): Promise<void> {
  await agentStore.setToolApproval(name, !isAutoApproved(name))
}

async function setAllInGroup(group: NamespaceGroup, autoApprove: boolean): Promise<void> {
  await Promise.all(group.tools.map((tool) => agentStore.setToolApproval(approvalName(tool), autoApprove)))
}

async function toggleNamespaceApproval(group: NamespaceGroup): Promise<void> {
  await setAllInGroup(group, namespaceApprovalState(group) !== 'all')
}

async function confirmAll(): Promise<void> {
  await Promise.all(tools.value.map((tool) => agentStore.setToolApproval(approvalName(tool), true)))
}

async function askAll(): Promise<void> {
  await Promise.all(tools.value.map((tool) => agentStore.setToolApproval(approvalName(tool), false)))
}

async function loadPolicyTools(): Promise<void> {
  loading.value = true
  try {
    const [policyTools] = await Promise.all([
      api.agent.listPolicyTools(),
      agentStore.loadToolApprovals(),
    ])
    tools.value = policyTools
  } finally {
    loading.value = false
  }
}

onMounted(loadPolicyTools)
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-6xl mx-auto py-8 px-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-theme-100">
            Tools
          </h1>
          <p class="text-sm text-theme-500 mt-1 max-w-3xl">
            Set the default HITL behaviour for every registered MCP and built-in tool. <strong class="text-theme-400">Auto-confirm</strong> lets the agent call the tool without asking you first; <strong class="text-theme-400">Ask</strong> pauses for your approval.
          </p>
        </div>

        <RouterLink
          to="/settings/mcp"
        >
          <button
            class="flex min-w-32 items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-medium transition-colors"
            @click="() => $router.push('/settings/mcp')"
          >
            <Icon
              icon="lucide:plus"
              class="w-4 h-4"
            />
            Add Tools
          </button>
        </RouterLink>
      </div>



      <div class="space-y-3">
        <div class="flex flex-col gap-3 rounded-xl border border-theme-800 bg-theme-900 p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-xs text-theme-500">
              {{ autoApprovedCount }}/{{ tools.length }} auto-confirmed
            </span>
            <div class="flex items-center gap-3">
              <button
                class="text-xs text-green-400 hover:text-green-300 transition-colors"
                @click="confirmAll"
              >
                Auto-confirm all
              </button>
              <button
                class="text-xs text-theme-400 hover:text-theme-200 transition-colors"
                @click="askAll"
              >
                Ask for all
              </button>
            </div>
          </div>

          <input
            v-model="filterText"
            type="text"
            placeholder="Search tools..."
            class="w-full bg-theme-950 border border-theme-700 rounded-lg px-3 py-2 text-sm text-theme-200 placeholder-theme-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
        </div>

        <DataTable
          :items="groupedTools"
          :columns="columns"
          :loading="loading"
          empty-message="No tools found"
          :row-class="(group) => isExpanded(group.id) ? 'bg-theme-800/30' : undefined"
          @row-click="toggleExpanded"
        >
          <template #col-category="{ item: group }">
            <div class="flex min-w-0 items-start gap-3">
              <Icon
                :icon="isExpanded(group.id) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                class="mt-0.5 h-4 w-4 shrink-0 text-theme-500"
              />
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="text-sm font-semibold"
                    :class="group.namespace.id === 'builtin:internal' ? 'text-violet-400' : group.namespace.id === 'builtin' ? 'text-accent-400' : 'text-theme-100'"
                  >{{ group.namespace.label }}</span>
                  <span class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-theme-500">
                    {{ group.tools.length }} tool{{ group.tools.length === 1 ? '' : 's' }}
                  </span>
                </div>
                <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-theme-500">
                  {{ group.description }}
                </p>
              </div>
            </div>
          </template>

          <template #col-state="{ item: group }">
            <div class="flex justify-end">
              <button
                class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors"
                :class="stateClass(namespaceApprovalState(group))"
                role="checkbox"
                :aria-checked="namespaceApprovalState(group) === 'partial' ? 'mixed' : namespaceApprovalState(group) === 'all'"
                :title="namespaceApprovalState(group) === 'all' ? 'All tools auto-confirmed. Click to require approval for all.' : 'Enable auto-confirm for all tools in this category.'"
                @click.stop="toggleNamespaceApproval(group)"
              >
                <Icon
                  :icon="stateIcon(namespaceApprovalState(group))"
                  class="h-3.5 w-3.5"
                />
                {{ namespaceApprovalLabel(group) }}
              </button>
            </div>
          </template>

          <template #row-expand="{ item: group }">
            <div
              v-if="isExpanded(group.id)"
              class="border-t border-theme-800 bg-theme-950/55 px-5 py-4"
            >
              <div class="space-y-3">
                <div
                  v-for="tool in group.tools"
                  :key="tool.key"
                  class="grid gap-3 rounded-lg border border-theme-800 bg-theme-900/55 p-3 md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class="font-mono text-sm"
                        :class="group.namespace.id === 'builtin:internal' ? 'text-violet-400' : group.namespace.id === 'builtin' ? 'text-accent-400' : 'text-theme-200'"
                      >{{ displayName(tool) }}</span>
                      <span class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-theme-500">
                        {{ toolCategory(tool) }}
                      </span>
                    </div>
                    <p class="mt-1 text-xs leading-relaxed text-theme-500">
                      {{ displayDescription(tool) }}
                    </p>

                    <div
                      v-if="toolParams(tool).length"
                      class="mt-3 flex flex-wrap gap-2"
                    >
                      <HoverTooltip
                        v-for="param in toolParams(tool)"
                        :key="param.name"
                        :disabled="!paramDescription(param)"
                        placement="above"
                        :max-width="320"
                      >
                        <span class="inline-flex items-baseline gap-1 rounded border border-theme-800 bg-theme-950/70 px-2 py-1 font-mono text-[11px]">
                          <span class="text-theme-300">{{ param.name }}</span>
                          <span class="text-theme-500">: {{ param.type }}{{ param.required ? '' : '?' }}</span>
                        </span>
                        <template #content>
                          <div class="whitespace-pre-line text-xs leading-relaxed text-theme-300">
                            {{ paramDescription(param) }}
                          </div>
                        </template>
                      </HoverTooltip>
                    </div>
                  </div>

                  <div class="flex items-start justify-end">
                    <button
                      class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors"
                      :class="isAutoApproved(approvalName(tool)) ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25' : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'"
                      :title="isAutoApproved(approvalName(tool)) ? 'Auto-confirmed - click to require approval' : 'Requires approval - click to auto-confirm'"
                      @click.stop="toggleApproval(approvalName(tool))"
                    >
                      <Icon
                        :icon="isAutoApproved(approvalName(tool)) ? 'lucide:shield-check' : 'lucide:shield-alert'"
                        class="h-3.5 w-3.5"
                      />
                      {{ isAutoApproved(approvalName(tool)) ? 'auto' : 'ask' }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </DataTable>
      </div>
    </div>
  </div>
</template>
