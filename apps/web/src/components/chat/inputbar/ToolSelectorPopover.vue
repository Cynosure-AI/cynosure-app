<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import { useAgentStore, type ToolInfo, type ToolNamespace } from '../../../stores/agent-runtime.store'
import { useChatStore } from '../../../stores/chat.store'
import { useMcpServers } from '../../../composables/useMcpServers'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId } from '../../../utils/internal-tools'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'

interface NamespaceGroup {
  namespace: ToolNamespace
  tools: ToolInfo[]
}

const BUILT_IN_NAMESPACE_DESCRIPTIONS: Record<string, string> = {
  'builtin:memory': 'Search, create, update, and organize persistent memory and knowledge.',
  'builtin:scheduling': 'Create, review, update, and remove scheduled agent tasks.',
  'builtin:notifications': 'Send notifications in Cynosure or through connected channels.',
  'builtin:utility': 'Work with attachments, MCP tools, planning, and sub-agent delegation.',
  builtin: 'Tools provided directly by Cynosure.',
}

const agentStore = useAgentStore()
const chatStore = useChatStore()
const { servers, loadServers } = useMcpServers()

const root = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const search = ref('')
const activeNamespaceId = ref<string | null>(null)
const menuStyle = ref<CSSProperties>({})
const brokenIcons = ref<Set<string>>(new Set())
const selectedToolKeysAtOpen = ref<Set<string>>(new Set())

const selectableTools = computed(() => agentStore.availableTools.filter(isSelectableTool))
const selectedSet = computed(() => new Set(chatStore.selectedToolNames))

const groups = computed<NamespaceGroup[]>(() => {
  const query = search.value.trim().toLowerCase()
  const grouped = new Map<string, NamespaceGroup>()

  for (const tool of selectableTools.value) {
    const matches = !query
      || tool.name.toLowerCase().includes(query)
      || tool.description.toLowerCase().includes(query)
      || tool.namespace.label.toLowerCase().includes(query)
    if (!matches) continue

    const existing = grouped.get(tool.namespace.id)
    if (existing) existing.tools.push(tool)
    else grouped.set(tool.namespace.id, { namespace: tool.namespace, tools: [tool] })
  }

  return [...grouped.values()].sort((a, b) => {
    const aBuiltIn = isBuiltInNamespaceId(a.namespace.id)
    const bBuiltIn = isBuiltInNamespaceId(b.namespace.id)
    if (aBuiltIn !== bBuiltIn) return aBuiltIn ? -1 : 1
    if (!aBuiltIn) {
      const aSelected = a.tools.some((tool) => selectedToolKeysAtOpen.value.has(tool.key))
      const bSelected = b.tools.some((tool) => selectedToolKeysAtOpen.value.has(tool.key))
      if (aSelected !== bSelected) return aSelected ? -1 : 1
    }
    return a.namespace.label.localeCompare(b.namespace.label)
  })
})

const activeGroup = computed(() => groups.value.find((group) => group.namespace.id === activeNamespaceId.value) ?? null)

function isSelectableTool(tool: ToolInfo): boolean {
  return !(isBuiltInNamespaceId(tool.namespace.id) && isAutoManagedBuiltInToolName(tool.name))
}

function selectedCount(group: NamespaceGroup): number {
  return group.tools.filter((tool) => selectedSet.value.has(tool.key)).length
}

function isGroupSelected(group: NamespaceGroup): boolean {
  return group.tools.length > 0 && selectedCount(group) === group.tools.length
}

function isGroupPartiallySelected(group: NamespaceGroup): boolean {
  const count = selectedCount(group)
  return count > 0 && count < group.tools.length
}

function toggleGroup(group: NamespaceGroup): void {
  const selected = new Set(chatStore.selectedToolNames)
  const shouldSelect = !isGroupSelected(group)
  for (const tool of group.tools) {
    if (shouldSelect) selected.add(tool.key)
    else selected.delete(tool.key)
  }
  chatStore.setSelectedToolNames([...selected])
}

function toggleTool(tool: ToolInfo): void {
  const selected = new Set(chatStore.selectedToolNames)
  if (selected.has(tool.key)) selected.delete(tool.key)
  else selected.add(tool.key)
  chatStore.setSelectedToolNames([...selected])
}

function setAutoRouting(enabled: boolean): void {
  chatStore.sessionAutoToolRouting = enabled
  chatStore.markOverridesModified()
}

function serverId(namespaceId: string): string | null {
  return namespaceId.startsWith('mcp:') ? namespaceId.slice(4) : null
}

function namespaceIcon(namespaceId: string): string | null {
  const id = serverId(namespaceId)
  if (!id || brokenIcons.value.has(namespaceId)) return null
  return servers.value.find((server) => server.id === id)?.icon_url ?? null
}

function namespaceDescription(namespace: ToolNamespace): string | undefined {
  if (namespace.description?.trim()) return namespace.description.trim()
  if (isBuiltInNamespaceId(namespace.id)) return BUILT_IN_NAMESPACE_DESCRIPTIONS[namespace.id] ?? BUILT_IN_NAMESPACE_DESCRIPTIONS.builtin
  const id = serverId(namespace.id)
  if (!id) return undefined
  const server = servers.value.find((item) => item.id === id)
  return server?.description?.trim() || server?.serverInfo?.description?.trim() || undefined
}

function markIconBroken(namespaceId: string): void {
  brokenIcons.value = new Set([...brokenIcons.value, namespaceId])
}

function updateMenuPosition(): void {
  const rect = root.value?.getBoundingClientRect()
  if (!rect) return
  const padding = 8
  const gap = 8
  const preferredHeight = 512
  const width = Math.min(300, window.innerWidth - padding * 2)
  const availableAbove = Math.max(0, rect.top - gap - padding)
  const availableBelow = Math.max(0, window.innerHeight - rect.bottom - gap - padding)
  const openAbove = availableAbove >= Math.min(280, preferredHeight) || availableAbove >= availableBelow
  const availableHeight = openAbove ? availableAbove : availableBelow
  const position = openAbove
    ? { bottom: `${window.innerHeight - rect.top + gap}px` }
    : { top: `${rect.bottom + gap}px` }

  menuStyle.value = {
    width: `${width}px`,
    left: `${Math.min(Math.max(rect.left, padding), window.innerWidth - width - padding)}px`,
    maxHeight: `${Math.min(preferredHeight, availableHeight)}px`,
    ...position,
  }
}

function showGroup(namespaceId: string): void {
  activeNamespaceId.value = namespaceId
}

function showNamespaceList(): void {
  activeNamespaceId.value = null
}

function close(): void {
  open.value = false
  activeNamespaceId.value = null
  search.value = ''
}

async function toggle(): Promise<void> {
  if (open.value) {
    close()
    return
  }
  selectedToolKeysAtOpen.value = new Set(chatStore.selectedToolNames)
  open.value = true
  await nextTick()
  updateMenuPosition()
}

function handleEscape(): void {
  if (activeNamespaceId.value) activeNamespaceId.value = null
  else close()
}

onClickOutside(root, close, { ignore: [menu] })

watch(open, (isOpen) => {
  if (isOpen && servers.value.length === 0) void loadServers().catch(() => undefined)
})

watch(groups, (nextGroups) => {
  if (activeNamespaceId.value && !nextGroups.some((group) => group.namespace.id === activeNamespaceId.value)) {
    activeNamespaceId.value = null
  }
})

onMounted(() => {
  window.addEventListener('resize', updateMenuPosition)
  window.addEventListener('scroll', updateMenuPosition, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateMenuPosition)
  window.removeEventListener('scroll', updateMenuPosition, true)
})
</script>

<template>
  <span
    ref="root"
    class="inline-flex"
  >
    <slot
      name="trigger"
      :open="open"
      :toggle="toggle"
      :close="close"
    />
  </span>

  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-100 ease-out"
      leave-active-class="transition duration-75 ease-in"
      enter-from-class="translate-y-1 opacity-0"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="open"
        ref="menu"
        class="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-theme-700 bg-theme-900 shadow-2xl shadow-black/40"
        :style="menuStyle"
        role="menu"
        aria-label="Tool access"
        @keydown.esc="handleEscape"
      >
        <div class="flex items-center gap-2 border-b border-theme-700 px-3 py-3">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-500/10 text-accent-400">
            <Icon
              icon="mdi:tools"
              class="h-4 w-4"
            />
          </span>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-theme-100">
              Auto Tool Selection
            </div>
            <div class="text-[10px] text-theme-500">
              Enable the auto tool mode to let the AI decide which tools to use for a task. You can still manually select tools below.
            </div>
          </div>
          <ToggleSwitch
            :model-value="chatStore.sessionAutoToolRouting"
            label="Automatic tool discovery"
            size="sm"
            color="accent"
            @update:model-value="setAutoRouting"
          />
        </div>

        <template v-if="activeGroup">
          <button
            type="button"
            class="flex w-full items-center gap-2 border-b border-theme-800 px-3 py-2.5 text-left text-xs text-theme-300 hover:bg-theme-800 hover:text-theme-100"
            aria-label="Back to MCP list"
            @click="showNamespaceList"
          >
            <Icon
              icon="lucide:chevron-left"
              class="h-4 w-4 shrink-0"
            />
            <span class="min-w-0 flex-1 truncate font-medium">{{ activeGroup.namespace.label }}</span>
            <span class="text-[10px] tabular-nums text-theme-600">{{ selectedCount(activeGroup) }}/{{ activeGroup.tools.length }}</span>
          </button>

          <div
            class="min-h-0 flex-1 overflow-y-auto p-1.5"
            role="menu"
            :aria-label="`${activeGroup.namespace.label} tools`"
          >
            <label
              v-for="tool in activeGroup.tools"
              :key="tool.key"
              class="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 hover:bg-theme-800"
            >
              <input
                type="checkbox"
                class="mt-0.5 h-4 w-4 shrink-0 accent-accent-500"
                :checked="selectedSet.has(tool.key)"
                @change="toggleTool(tool)"
              >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium text-theme-200">{{ tool.name }}</span>
                <span class="mt-0.5 block line-clamp-2 text-[10px] leading-snug text-theme-500">
                  {{ tool.description.replace(/^\[MCP:\s*[^\]]*\]\s*/, '') || 'No description available' }}
                </span>
              </span>
            </label>
          </div>
        </template>

        <template v-else>
          <div class="border-b border-theme-800 p-2">
            <label class="flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-800 px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-accent-500">
              <Icon
                icon="lucide:search"
                class="h-3.5 w-3.5 shrink-0 text-theme-500"
              />
              <input
                v-model="search"
                type="search"
                class="min-w-0 flex-1 bg-transparent text-xs text-theme-200 outline-none placeholder:text-theme-600"
                placeholder="Search MCPs and tools..."
                aria-label="Search MCPs and tools"
              >
            </label>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
            <div
              v-for="group in groups"
              :key="group.namespace.id"
              :title="namespaceDescription(group.namespace)"
              class="group cursor-pointer flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-theme-300 transition-colors hover:bg-theme-800/70 hover:text-theme-100"
              role="menuitem"
              tabindex="0"
              aria-haspopup="menu"
              aria-expanded="false"
              @click="toggleGroup(group)"
              @keydown.enter.prevent="showGroup(group.namespace.id)"
              @keydown.space.prevent="showGroup(group.namespace.id)"
            >
              <button
                type="button"
                class="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                :class="isGroupSelected(group) || isGroupPartiallySelected(group) ? 'border-accent-500 bg-accent-500 text-white' : 'border-theme-600 bg-theme-950'"
                role="checkbox"
                :aria-checked="isGroupPartiallySelected(group) ? 'mixed' : isGroupSelected(group)"
                :aria-label="`Toggle all tools in ${group.namespace.label}`"
                @click.stop="toggleGroup(group)"
              >
                <Icon
                  v-if="isGroupSelected(group)"
                  icon="lucide:check"
                  class="h-3 w-3"
                />
                <Icon
                  v-else-if="isGroupPartiallySelected(group)"
                  icon="lucide:minus"
                  class="h-3 w-3"
                />
              </button>
              <span class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-theme-800">
                <img
                  v-if="namespaceIcon(group.namespace.id)"
                  :src="namespaceIcon(group.namespace.id)!"
                  alt=""
                  class="h-5 w-5 object-contain"
                  @error="markIconBroken(group.namespace.id)"
                >
                <Icon
                  v-else
                  :icon="isBuiltInNamespaceId(group.namespace.id) ? 'lucide:blocks' : 'lucide:plug'"
                  class="h-4 w-4 text-theme-400"
                />
              </span>
              <span class="min-w-0 flex-1 truncate text-xs">{{ group.namespace.label }}</span>
              <button
                type="button"
                class="flex rounded-lg hover:border hover:border-theme-600 group-hover:bg-theme-800/70 group-hover:text-theme-100 p-1 pl-2"
                :aria-label="`Open ${group.namespace.label} tools`"
                @click.stop="showGroup(group.namespace.id)"
              >
                <span class="text-[10px] tabular-nums text-theme-600">{{ selectedCount(group) }}/{{ group.tools.length }}</span>
                <Icon
                  icon="lucide:chevron-right"
                  class="h-3.5 w-3.5 shrink-0 text-theme-600 group-hover:text-theme-400"
                />
              </button>
            </div>

            <div
              v-if="groups.length === 0"
              class="px-3 py-6 text-center text-xs text-theme-500"
            >
              No MCPs or tools match “{{ search }}”
            </div>
          </div>
        </template>

        <div class="flex items-center justify-between border-t border-theme-800 px-3 py-2 text-[10px] text-theme-500">
          <span>{{ chatStore.selectedToolNames.length }} tool{{ chatStore.selectedToolNames.length === 1 ? '' : 's' }} enabled</span>
          <button
            v-if="chatStore.selectedToolNames.length"
            type="button"
            class="text-theme-400 hover:text-theme-200"
            @click="chatStore.setSelectedToolNames([])"
          >
            Clear all
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
