<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../api/client'
import { useAgentStore, type ToolInfo, type ToolNamespace } from '../stores/agent-runtime.store.ts'
import DataTable, { type Column } from '../components/shared/DataTable.vue'
import HoverTooltip from '../components/shared/HoverTooltip.vue'
import ToolBehaviorBadges from '../components/shared/ToolBehaviorBadges.vue'
import ApprovalModeControl, { type ApprovalMode } from '../components/shared/ApprovalModeControl.vue'
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

type GroupMode = ApprovalMode | 'mixed'
type StateFilter = 'all' | 'allowed' | 'ask' | 'custom'

const agentStore = useAgentStore()
const { servers, loadServers } = useMcpServers()
const tools = ref<ToolInfo[]>([])
const brokenIcons = ref<Set<string>>(new Set())
const filterText = ref('')
const stateFilter = ref<StateFilter>('all')
const expandedGroupIds = ref<Set<string>>(new Set())
const loading = ref(true)
const pending = ref(false)
const errorMessage = ref('')
let expandedBeforeNarrowing: Set<string> | null = null
let searchExpansionTimer: number | undefined

const columns: Column<NamespaceGroup>[] = [
  {
    key: 'icon',
    label: '',
    ariaLabel: 'Icon',
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
    label: 'Approval',
    width: '210px',
    class: 'text-right',
    sortable: true,
    sortValue: (group) => groupModeSort(group),
  },
]

const stateFilters: { value: StateFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'allowed', label: 'Allowed' },
  { value: 'ask', label: 'Asks' },
  { value: 'custom', label: 'Customized' },
]

const searchedTools = computed(() => {
  const query = filterText.value.trim().toLowerCase()
  if (!query) return tools.value

  return tools.value.filter((tool) =>
    tool.name.toLowerCase().includes(query) ||
    displayDescription(tool).toLowerCase().includes(query) ||
    tool.namespace.label.toLowerCase().includes(query) ||
    toolInjectionCondition(tool.name, tool.namespace.id).toLowerCase().includes(query)
  )
})

const stateCounts = computed<Record<StateFilter, number>>(() => ({
  all: searchedTools.value.length,
  allowed: searchedTools.value.filter((tool) => matchesState(tool, 'allowed')).length,
  ask: searchedTools.value.filter((tool) => matchesState(tool, 'ask')).length,
  custom: searchedTools.value.filter((tool) => matchesState(tool, 'custom')).length,
}))

const filteredTools = computed(() =>
  searchedTools.value.filter((tool) => matchesState(tool, stateFilter.value))
)

const isNarrowed = computed(() => filterText.value.trim() !== '' || stateFilter.value !== 'all')

const groupedTools = computed<NamespaceGroup[]>(() => {
  const groups = new Map<string, NamespaceGroup>()

  for (const tool of filteredTools.value) {
    const namespace = tool.namespace
    if (!groups.has(namespace.id)) {
      groups.set(namespace.id, {
        id: namespace.id,
        namespace,
        description: namespaceDescription(namespace),
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

const allExpanded = computed(() =>
  groupedTools.value.length > 0 && groupedTools.value.every((group) => expandedGroupIds.value.has(group.id))
)

const bulkScopeLabel = computed(() =>
  isNarrowed.value
    ? `${filteredTools.value.length} shown tool${filteredTools.value.length === 1 ? '' : 's'}`
    : `all ${tools.value.length} tools`
)

function matchesState(tool: ToolInfo, filter: StateFilter): boolean {
  if (filter === 'allowed') return tool.autoApprove
  if (filter === 'ask') return !tool.autoApprove
  if (filter === 'custom') return !tool.usesDefaultApproval
  return true
}

function namespaceDescription(namespace: ToolNamespace): string {
  if (namespace.id.startsWith('mcp:')) {
    const server = servers.value.find((entry) => entry.id === namespace.id.slice(4))
    const description = server?.serverInfo?.description || server?.description
    if (description) return description
  }
  return namespace.description ?? ''
}

function toolNamePreview(group: NamespaceGroup): string {
  const names = group.tools.map(displayName)
  const shown = names.slice(0, 4).join(', ')
  return names.length > 4 ? `${shown} +${names.length - 4} more` : shown
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

function toolMode(tool: ToolInfo): ApprovalMode {
  if (tool.usesDefaultApproval) return 'default'
  return tool.autoApprove ? 'allow' : 'ask'
}

function groupMode(group: NamespaceGroup): GroupMode {
  const first = toolMode(group.tools[0])
  return group.tools.every((tool) => toolMode(tool) === first) ? first : 'mixed'
}

function groupAllowedCount(group: NamespaceGroup): number {
  return group.tools.filter((tool) => tool.autoApprove).length
}

function groupModeSort(group: NamespaceGroup): number {
  return groupAllowedCount(group) / group.tools.length
}

function namespaceIconUrl(namespaceId: string): string | null {
  if (!namespaceId.startsWith('mcp:') || brokenIcons.value.has(namespaceId)) return null
  return servers.value.find((server) => server.id === namespaceId.slice(4))?.icon_url ?? null
}

function markIconBroken(namespaceId: string): void {
  brokenIcons.value = new Set([...brokenIcons.value, namespaceId])
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

function toggleExpandAll(): void {
  expandedGroupIds.value = allExpanded.value
    ? new Set()
    : new Set(groupedTools.value.map((group) => group.id))
}

function clearFilters(): void {
  filterText.value = ''
  stateFilter.value = 'all'
}

/** Expand matching groups while narrowing; restore the previous layout once filters are cleared. */
function syncNarrowingExpansion(): void {
  if (isNarrowed.value) {
    expandedBeforeNarrowing ??= new Set(expandedGroupIds.value)
    expandedGroupIds.value = new Set(groupedTools.value.map((group) => group.id))
  } else if (expandedBeforeNarrowing) {
    expandedGroupIds.value = expandedBeforeNarrowing
    expandedBeforeNarrowing = null
  }
}

async function runUpdate(update: () => Promise<unknown>): Promise<void> {
  if (pending.value) return
  pending.value = true
  errorMessage.value = ''
  try {
    await update()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to update tool approvals.'
  } finally {
    try {
      await refreshPolicyTools()
    } catch {
      // Keep the last known state; the update error (if any) is already shown.
    }
    pending.value = false
  }
}

function applyMode(policyTools: ToolInfo[], mode: ApprovalMode): Promise<unknown> {
  if (mode === 'default') return api.agent.resetToolApprovalsToDefaults(policyTools.map(approvalName))
  const approvals = Object.fromEntries(policyTools.map((tool) => [approvalName(tool), mode === 'allow']))
  return api.agent.setToolApprovalsBulk(approvals)
}

function confirmAllow(policyTools: ToolInfo[]): boolean {
  const risky = policyTools.filter((tool) => !tool.autoApprove && tool.annotations?.readOnlyHint !== true)
  if (risky.length === 0) return true
  const destructive = risky.filter((tool) => tool.annotations?.destructiveHint === true).length
  const detail = destructive > 0 ? ` (${destructive} marked destructive)` : ''
  return window.confirm(
    `Allow ${risky.length} tool${risky.length === 1 ? '' : 's'} that may modify data${detail} to run without asking?`
  )
}

function setToolMode(tool: ToolInfo, mode: ApprovalMode): void {
  void runUpdate(() => applyMode([tool], mode))
}

function setGroupMode(group: NamespaceGroup, mode: ApprovalMode): void {
  if (mode === 'allow' && group.tools.length > 1 && !confirmAllow(group.tools)) return
  void runUpdate(() => applyMode(group.tools, mode))
}

function setVisibleMode(mode: ApprovalMode): void {
  const policyTools = filteredTools.value
  if (policyTools.length === 0) return
  if (mode === 'allow' && !confirmAllow(policyTools)) return
  void runUpdate(() => applyMode(policyTools, mode))
}

async function loadPolicyTools(): Promise<void> {
  loading.value = true
  try {
    await refreshPolicyTools()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to load tools.'
  } finally {
    loading.value = false
  }
}

async function refreshPolicyTools(): Promise<void> {
  const policyTools = await api.agent.listPolicyTools()
  tools.value = policyTools
  agentStore.syncToolApprovals(policyTools)
}

watch(filterText, () => {
  window.clearTimeout(searchExpansionTimer)
  searchExpansionTimer = window.setTimeout(syncNarrowingExpansion, 150)
})

watch(stateFilter, syncNarrowingExpansion)

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
    <header class="page-header z-10 border-b border-theme-800/60 bg-theme-950/95 py-4 backdrop-blur-sm sm:sticky sm:top-0 sm:py-5">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:flex-row sm:items-start sm:justify-between sm:px-6 lg:px-8">
        <div class="min-w-0">
          <h1 class="text-2xl font-bold text-theme-100">
            Tools
          </h1>
          <p class="mt-1 max-w-3xl text-sm leading-relaxed text-ink-muted">
            Set the approval behaviour for every registered MCP and built-in tool. <strong class="text-ink-secondary">Allow</strong> lets the agent call a tool without asking; <strong class="text-ink-secondary">Ask</strong> pauses for your approval; <strong class="text-ink-secondary">Default</strong> follows each tool's behavior annotations (read-only tools are allowed, everything else asks).
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
          <div class="relative">
            <Icon
              icon="lucide:search"
              class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
            />
            <input
              v-model="filterText"
              type="text"
              placeholder="Search tools, descriptions, or MCP servers..."
              aria-label="Search tools"
              class="w-full rounded-lg border border-theme-700 bg-theme-950 py-2 pl-9 pr-9 text-sm text-theme-200 placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-accent-500"
              @keydown.esc="filterText = ''"
            >
            <button
              v-if="filterText"
              type="button"
              class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-200"
              title="Clear search (Esc)"
              aria-label="Clear search"
              @click="filterText = ''"
            >
              <Icon
                icon="lucide:x"
                class="h-3.5 w-3.5"
              />
            </button>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3">
            <div
              class="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Filter by approval state"
            >
              <button
                v-for="filter in stateFilters"
                :key="filter.value"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                :class="stateFilter === filter.value
                  ? 'border-accent-500/60 bg-accent-500/15 text-theme-100'
                  : 'border-theme-700 text-ink-muted hover:border-theme-600 hover:text-theme-200'"
                :aria-pressed="stateFilter === filter.value"
                @click="stateFilter = filter.value"
              >
                {{ filter.label }}
                <span class="tabular-nums text-ink-muted">{{ stateCounts[filter.value] }}</span>
              </button>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-ink-muted">Set {{ bulkScopeLabel }} to</span>
              <ApprovalModeControl
                mode="mixed"
                label="Set approval for shown tools"
                :disabled="pending || filteredTools.length === 0"
                @change="setVisibleMode"
              />
            </div>
          </div>
        </div>

        <div
          v-if="errorMessage"
          class="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-status-danger"
          role="alert"
        >
          <Icon
            icon="lucide:circle-alert"
            class="mt-px h-3.5 w-3.5 shrink-0"
          />
          <span class="flex-1">{{ errorMessage }}</span>
          <button
            type="button"
            class="text-ink-muted hover:text-theme-200"
            aria-label="Dismiss error"
            @click="errorMessage = ''"
          >
            <Icon
              icon="lucide:x"
              class="h-3.5 w-3.5"
            />
          </button>
        </div>

        <div class="flex items-center justify-between px-1 text-xs text-ink-muted">
          <span>
            {{ groupedTools.length }} group{{ groupedTools.length === 1 ? '' : 's' }} · {{ filteredTools.length }} tool{{ filteredTools.length === 1 ? '' : 's' }}
            <button
              v-if="isNarrowed"
              type="button"
              class="ml-2 text-status-info hover:text-sky-300"
              @click="clearFilters"
            >
              Clear filters
            </button>
          </span>
          <button
            v-if="groupedTools.length"
            type="button"
            class="inline-flex items-center gap-1 transition-colors hover:text-theme-200"
            @click="toggleExpandAll"
          >
            <Icon
              :icon="allExpanded ? 'lucide:chevrons-down-up' : 'lucide:chevrons-up-down'"
              class="h-3.5 w-3.5"
            />
            {{ allExpanded ? 'Collapse all' : 'Expand all' }}
          </button>
        </div>

        <DataTable
          :items="groupedTools"
          :columns="columns"
          :loading="loading"
          :row-clickable="true"
          :empty-message="isNarrowed ? 'No tools match your filters' : 'No tools registered'"
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
                  <span
                    class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide tabular-nums"
                    :class="groupAllowedCount(group) === 0
                      ? 'bg-amber-500/10 text-status-warning'
                      : groupAllowedCount(group) === group.tools.length
                        ? 'bg-green-500/10 text-status-green'
                        : 'bg-theme-800 text-ink-secondary'"
                  >
                    {{ groupAllowedCount(group) }}/{{ group.tools.length }} allowed
                  </span>
                </div>
                <p
                  v-if="group.description"
                  class="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted"
                >
                  {{ group.description }}
                </p>
                <p
                  v-else
                  class="mt-1 truncate font-mono text-[11px] text-ink-muted"
                >
                  {{ toolNamePreview(group) }}
                </p>
              </div>
            </div>
          </template>

          <template #col-state="{ item: group }">
            <div class="flex justify-end">
              <ApprovalModeControl
                :mode="groupMode(group)"
                :label="`Approval for ${group.namespace.label}`"
                :disabled="pending"
                @change="(mode) => setGroupMode(group, mode)"
              />
            </div>
          </template>

          <template #row-expand="{ item: group }">
            <div
              v-if="isExpanded(group.id)"
              class="border-t border-theme-800 bg-theme-950/55 px-5 py-4"
            >
              <div class="divide-y divide-theme-800/70 overflow-hidden rounded-lg border border-theme-800 bg-theme-900/40">
                <div
                  v-for="tool in group.tools"
                  :key="tool.key"
                  class="flex items-center justify-between gap-3 p-3 hover:bg-theme-800/30"
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
                        <span
                          v-if="toolInjectionCondition(tool.name, tool.namespace.id)"
                          class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted"
                        >
                          {{ toolInjectionCondition(tool.name, tool.namespace.id) }}
                        </span>
                        <ToolBehaviorBadges :annotations="tool.annotations" />
                      </div>
                      <p class="mt-0.5 text-xs leading-snug text-ink-muted">
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

                  <ApprovalModeControl
                    :mode="toolMode(tool)"
                    :default-allows="tool.autoApprove"
                    :label="`Approval for ${displayName(tool)}`"
                    :disabled="pending"
                    @change="(mode) => setToolMode(tool, mode)"
                  />
                </div>
              </div>
            </div>
          </template>
        </DataTable>
      </div>
    </div>
  </div>
</template>
