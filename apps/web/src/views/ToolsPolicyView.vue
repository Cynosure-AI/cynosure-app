<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../api/client'
import { useAgentStore, type ToolInfo, type ToolNamespace } from '../stores/agent-runtime.store.ts'
import DataTable, { type Column } from '../components/shared/DataTable.vue'
import HoverTooltip from '../components/shared/HoverTooltip.vue'
import ToolBehaviorBadges from '../components/shared/ToolBehaviorBadges.vue'
import { isBuiltInNamespaceId } from '../utils/internal-tools'
import { toolInjectionCondition } from '../utils/tool-injection-condition'
import { useMcpServers } from '../composables/useMcpServers'
import { getToolNamespaceIcon } from '../utils/tool-namespace-icons'

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

type ApprovalState = 'all' | 'defaults' | 'none' | 'partial'

const agentStore = useAgentStore()
const { servers, loadServers } = useMcpServers()
const tools = ref<ToolInfo[]>([])
const brokenIcons = ref<Set<string>>(new Set())
const filterText = ref('')
const expandedGroupIds = ref<Set<string>>(new Set())
const loading = ref(true)
const defaultApprovalNames = ref<Set<string>>(new Set())
const debouncedSearchExpansion = ref(false)
let searchExpansionTimer: number | undefined

const columns: Column<NamespaceGroup>[] = [
  {
    key: 'icon',
    label: '',
    width: '40px',
  },
  {
    key: 'category',
    label: 'Category / MCP',
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
    toolInjectionCondition(tool.name, tool.namespace.id).toLowerCase().includes(query)
  )
})

const groupedTools = computed<NamespaceGroup[]>(() => {
  const groups = new Map<string, NamespaceGroup>()

  for (const tool of filteredTools.value) {
    const namespace = normalizeNamespace(tool.namespace)
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
      const rank = (ns: string) => (isBuiltInNamespaceId(ns) ? 0 : 1)
      const ra = rank(a.namespace.id), rb = rank(b.namespace.id)
      return ra !== rb ? ra - rb : a.namespace.label.localeCompare(b.namespace.label)
    })
})

const autoApprovedCount = computed(() =>
  tools.value.filter((tool) => isAutoApproved(approvalName(tool))).length
)

function normalizeNamespace(namespace: ToolNamespace): ToolNamespace {
  return namespace
}

function namespaceDescription(namespace: ToolNamespace, firstTool: ToolInfo): string {
  if (isBuiltInNamespaceId(namespace.id)) return `Cynosure ${namespace.label.toLowerCase()} tools.`
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

function toolApprovalLabel(tool: ToolInfo): string {
  return defaultApprovalNames.value.has(approvalName(tool))
    ? 'default'
    : isAutoApproved(approvalName(tool)) ? 'allow' : 'ask'
}

function namespaceAutoApprovedCount(group: NamespaceGroup): number {
  return group.tools.filter((tool) => isAutoApproved(approvalName(tool))).length
}

function namespaceApprovalState(group: NamespaceGroup): ApprovalState {
  if (group.tools.every((tool) => defaultApprovalNames.value.has(approvalName(tool)))) return 'defaults'
  const autoCount = namespaceAutoApprovedCount(group)
  if (autoCount === 0) return 'none'
  if (autoCount === group.tools.length) return 'all'
  return 'partial'
}

function namespaceApprovalSort(group: NamespaceGroup): number {
  const state = namespaceApprovalState(group)
  if (state === 'all') return 3
  if (state === 'defaults') return 2
  if (state === 'partial') return 1
  return 0
}

function namespaceApprovalLabel(group: NamespaceGroup): string {
  const state = namespaceApprovalState(group)
  if (state === 'all') return 'all allow'
  if (state === 'defaults') return 'default'
  if (state === 'none') return 'all ask'
  return 'mixed'
}

function namespaceIconUrl(namespaceId: string): string | null {
  if (!namespaceId.startsWith('mcp:') || brokenIcons.value.has(namespaceId)) return null
  return servers.value.find((server) => server.id === namespaceId.slice(4))?.icon_url ?? null
}

function markIconBroken(namespaceId: string): void {
  brokenIcons.value = new Set([...brokenIcons.value, namespaceId])
}

function stateIcon(state: ApprovalState): string {
  if (state === 'all') return 'lucide:shield-check'
  if (state === 'defaults') return 'lucide:rotate-ccw'
  if (state === 'none') return 'lucide:shield-alert'
  return 'lucide:shield'
}

function stateClass(state: ApprovalState): string {
  if (state === 'all') return 'bg-green-500/15 text-status-green hover:bg-green-500/25'
  if (state === 'defaults') return 'bg-sky-500/15 text-status-info hover:bg-sky-500/25'
  if (state === 'none') return 'bg-amber-500/10 text-status-warning hover:bg-amber-500/20'
  return 'bg-accent-500/15 text-accent-fg hover:bg-accent-500/25'
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
  return debouncedSearchExpansion.value || expandedGroupIds.value.has(groupId)
}

function toggleExpanded(group: NamespaceGroup): void {
  const next = new Set(expandedGroupIds.value)
  if (next.has(group.id)) next.delete(group.id)
  else next.add(group.id)
  expandedGroupIds.value = next
}

async function toggleApproval(name: string): Promise<void> {
  await agentStore.setToolApproval(name, !isAutoApproved(name))
  await refreshPolicyTools()
}

async function setAllInGroup(group: NamespaceGroup, autoApprove: boolean): Promise<void> {
  await setApprovals(group.tools, autoApprove)
}

async function setApprovals(policyTools: ToolInfo[], autoApprove: boolean): Promise<void> {
  const approvals = Object.fromEntries(policyTools.map((tool) => [approvalName(tool), autoApprove]))
  await api.agent.setToolApprovalsBulk(approvals)
  await refreshPolicyTools()
}

async function restoreDefaults(policyTools: ToolInfo[]): Promise<void> {
  const names = policyTools.map(approvalName)
  await api.agent.resetToolApprovalsToDefaults(names)
  await refreshPolicyTools()
}

async function toggleNamespaceApproval(group: NamespaceGroup): Promise<void> {
  const state = namespaceApprovalState(group)
  if (state === 'all' || state === 'partial') {
    await restoreDefaults(group.tools)
  } else if (state === 'defaults') {
    await setAllInGroup(group, false)
  } else {
    await setAllInGroup(group, true)
  }
}

async function confirmAll(): Promise<void> {
  await setApprovals(tools.value, true)
}

async function defaultsAll(): Promise<void> {
  await restoreDefaults(tools.value)
}

async function askAll(): Promise<void> {
  await setApprovals(tools.value, false)
}

async function loadPolicyTools(): Promise<void> {
  loading.value = true
  try {
    await refreshPolicyTools()
  } finally {
    loading.value = false
  }
}

async function refreshPolicyTools(): Promise<void> {
  const policyTools = await api.agent.listPolicyTools()
  tools.value = policyTools
  agentStore.syncToolApprovals(policyTools)
  defaultApprovalNames.value = new Set(
    policyTools.filter((tool) => tool.usesDefaultApproval).map(approvalName)
  )
}

watch(filterText, (value) => {
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
  void loadPolicyTools()
  void loadServers().catch(() => undefined)
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <header class="z-10 border-b border-theme-800/60 bg-theme-950/95 py-4 backdrop-blur-sm sm:sticky sm:top-0 sm:py-5">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:flex-row sm:items-start sm:justify-between sm:px-6 lg:px-8">
        <div class="min-w-0">
          <h1 class="text-2xl font-bold text-theme-100">
            Tools
          </h1>
          <p class="mt-1 max-w-3xl text-sm leading-relaxed text-ink-muted">
            Set the approval behaviour for every registered MCP and built-in tool. <strong class="text-ink-secondary">Allow</strong> lets the agent call a tool without asking; <strong class="text-ink-secondary">Ask</strong> pauses for your approval; <strong class="text-ink-secondary">Default</strong> follows each tool's behavior annotations.
          </p>
        </div>
        <RouterLink
          to="/settings/mcp"
          class="inline-flex h-10 shrink-0 items-center gap-2 self-start rounded-lg accent-action bg-accent-600 px-4 text-sm font-medium text-accent-on transition-colors hover:bg-accent-500"
        >
          <Icon
            icon="lucide:plus"
            class="h-4 w-4"
          />
          Add Tools
        </RouterLink>
      </div>
    </header>

    <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div class="space-y-3">
        <div class="flex flex-col gap-3 rounded-xl border border-theme-800 bg-theme-900 p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-xs text-ink-muted">
              {{ autoApprovedCount }}/{{ tools.length }} allowed
            </span>
            <div class="flex items-center gap-3">
              <button
                class="text-xs text-status-green hover:text-green-300 transition-colors"
                @click="confirmAll"
              >
                Allow all
              </button>
              <button
                class="text-xs text-status-info hover:text-sky-300 transition-colors"
                title="Use annotation defaults: read-only tools are allowed; write, destructive, and unannotated tools ask"
                @click="defaultsAll"
              >
                Default
              </button>
              <button
                class="text-xs text-ink-secondary hover:text-theme-200 transition-colors"
                @click="askAll"
              >
                Ask all
              </button>
            </div>
          </div>

          <input
            v-model="filterText"
            type="text"
            placeholder="Search tools..."
            class="w-full bg-theme-950 border border-theme-700 rounded-lg px-3 py-2 text-sm text-theme-200 placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
        </div>

        <DataTable
          :items="groupedTools"
          :columns="columns"
          :loading="loading"
          :row-clickable="true"
          empty-message="No tools found"
          :row-class="(group) => isExpanded(group.id) ? 'bg-theme-800/30' : undefined"
          @row-click="toggleExpanded"
        >
          <template #col-icon="{ item: group }">
            <span class="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md bg-theme-800/80">
              <img
                v-if="namespaceIconUrl(group.namespace.id)"
                :src="namespaceIconUrl(group.namespace.id)!"
                alt=""
                class="h-5 w-5 object-contain"
                @error="markIconBroken(group.namespace.id)"
              >
              <Icon
                v-else
                :icon="getToolNamespaceIcon(group.namespace.id)"
                class="h-4 w-4 text-ink-secondary"
              />
            </span>
          </template>

          <template #col-category="{ item: group }">
            <div class="flex min-w-0 items-start gap-3">
              <Icon
                :icon="isExpanded(group.id) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                class="mt-0.5 h-4 w-4 shrink-0 text-ink-muted"
              />
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="text-sm font-semibold"
                    :class="isBuiltInNamespaceId(group.namespace.id) ? 'text-accent-fg' : 'text-theme-100'"
                  >{{ group.namespace.label }}</span>
                  <span class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                    {{ group.tools.length }} tool{{ group.tools.length === 1 ? '' : 's' }}
                  </span>
                </div>
                <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted">
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
                :aria-checked="namespaceApprovalState(group) === 'partial' || namespaceApprovalState(group) === 'defaults' ? 'mixed' : namespaceApprovalState(group) === 'all'"
                :title="namespaceApprovalState(group) === 'all'
                  ? 'All tools are allowed. Click to restore annotation defaults.'
                  : namespaceApprovalState(group) === 'defaults'
                    ? 'Using annotation defaults. Click to require approval for all.'
                    : namespaceApprovalState(group) === 'none'
                      ? 'All tools ask. Click to allow all.'
                      : 'Custom mix. Click to restore annotation defaults.'"
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
                  class="flex items-center justify-between gap-3 rounded-lg border border-theme-800 bg-theme-900/55 p-3"
                >
                  <HoverTooltip
                    :block="true"
                    placement="mouse"
                    :max-width="360"
                  >
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span
                          class="font-mono text-sm"
                          :class="isBuiltInNamespaceId(group.namespace.id) ? 'text-accent-fg' : 'text-theme-200'"
                        >{{ displayName(tool) }}</span>
                        <span class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                          {{ toolInjectionCondition(tool.name, tool.namespace.id) }}
                        </span>
                        <ToolBehaviorBadges :annotations="tool.annotations" />
                      </div>
                      <p class="mt-1 text-xs leading-relaxed text-ink-muted">
                        {{ displayDescription(tool) }}
                      </p>
                    </div>
                    <template #content>
                      <div
                        v-if="toolParams(tool).length"
                        class="space-y-1"
                      >
                        <p class="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                          Parameters
                        </p>
                        <div
                          v-for="param in toolParams(tool)"
                          :key="param.name"
                          class="text-[11px] leading-snug text-theme-300"
                        >
                          <span class="font-mono text-theme-200">{{ param.name }}</span>
                          <span class="text-ink-muted">: {{ param.type }}{{ param.required ? '' : '?' }}</span>
                          <span
                            v-if="paramDescription(param)"
                            class="block text-ink-secondary mt-0.5"
                          >{{ paramDescription(param) }}</span>
                        </div>
                      </div>
                      <div
                        v-else
                        class="text-[11px] text-ink-secondary"
                      >
                        No parameters.
                      </div>
                    </template>
                  </HoverTooltip>

                  <button
                    class="shrink-0 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors"
                    :class="isAutoApproved(approvalName(tool)) ? 'bg-green-500/15 text-status-green hover:bg-green-500/25' : 'bg-amber-500/10 text-status-warning hover:bg-amber-500/20'"
                    :title="isAutoApproved(approvalName(tool)) ? 'Allowed - click to require approval' : 'Requires approval - click to allow'"
                    @click.stop="toggleApproval(approvalName(tool))"
                  >
                    <Icon
                      :icon="isAutoApproved(approvalName(tool)) ? 'lucide:shield-check' : 'lucide:shield-alert'"
                      class="h-3.5 w-3.5"
                    />
                    {{ toolApprovalLabel(tool) }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </DataTable>
      </div>
    </div>
  </div>
</template>
