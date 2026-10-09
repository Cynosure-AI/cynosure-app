<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CSSProperties } from 'vue'
import type { MemoryFolder } from '../../../api/types'
import type { ToolInfo } from '../../../stores/agent-runtime.store'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import { useChatStore } from '../../../stores/chat.store'
import { useAgentStore } from '../../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { useMcpServers } from '../../../composables/useMcpServers'
import { useProjectsStore } from '../../../stores/projects.store'
import { useRouter } from 'vue-router'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId } from '../../../utils/internal-tools'
import { getToolNamespaceIcon } from '../../../utils/tool-namespace-icons'
import { isAutoExcludedMemoryFolder, isMemoryFolderSelected } from '../../../utils/memory-folder-selection'
import SystemPromptModal from '../modals/SystemPromptModal.vue'

const emit = defineEmits<{ attach: []; browseLibrary: [] }>()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const { servers, loadServers } = useMcpServers()
const projectsStore = useProjectsStore()
const router = useRouter()

type Panel = 'main' | 'files' | 'tools' | 'memory' | 'agents' | 'project'
const root = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const panel = ref<Panel>('main')
const search = ref('')
const folderPath = ref<string | null>(null)
const toolNamespace = ref<string | null>(null)
const showSystemPrompt = ref(false)
const menuStyle = ref<CSSProperties>({})
const brokenMcpIcons = ref<Set<string>>(new Set())

const entries = [
  { id: 'files', label: 'Files', detail: 'Upload or select from library', icon: 'lucide:paperclip' },
  { id: 'tools', label: 'Tools (MCPs)', detail: 'Enable and configure tools', icon: 'lucide:wrench' },
  { id: 'memory', label: 'Memories', detail: 'Select memory folders', icon: 'lucide:brain' },
  { id: 'agents', label: 'Subagents', detail: 'Enable and configure subagents', icon: 'lucide:users' },
  { id: 'project', label: 'Project', detail: 'Run this chat inside a project', icon: 'lucide:folder-kanban' },
  { id: 'prompt', label: 'System Prompt', detail: 'View and edit system prompt', icon: 'lucide:scroll-text' },
] as const
const selectableTools = computed(() => agentStore.availableTools.filter(tool => !(isBuiltInNamespaceId(tool.namespace.id) && isAutoManagedBuiltInToolName(tool.name))))
const toolGroups = computed(() => {
  const groups = new Map<string, { id: string; label: string; tools: ToolInfo[] }>()
  for (const tool of selectableTools.value) {
    const existing = groups.get(tool.namespace.id)
    if (existing) existing.tools.push(tool)
    else groups.set(tool.namespace.id, { id: tool.namespace.id, label: tool.namespace.label, tools: [tool] })
  }
  const query = search.value.toLowerCase().trim()
  return [...groups.values()].filter(group => !query || group.label.toLowerCase().includes(query) || group.tools.some(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query)))
    .sort((a, b) => Number(isBuiltInNamespaceId(b.id)) - Number(isBuiltInNamespaceId(a.id)) || a.label.localeCompare(b.label))
})
const activeTools = computed(() => {
  const group = toolGroups.value.find(item => item.id === toolNamespace.value)
  if (!group) return []
  const query = search.value.toLowerCase().trim()
  return !query || group.label.toLowerCase().includes(query)
    ? group.tools
    : group.tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query))
})
const visibleAgents = computed(() => agentDefs.agents.filter(agent => `${agent.name} ${agent.internalName || ''} ${agent.description || ''}`.toLowerCase().includes(search.value.toLowerCase().trim())))
const folders = computed(() => chatStore.memoryFolders)
const folderSet = computed(() => new Set(chatStore.freeChatMemoryFolderIds))
const rootFolder = computed(() => folders.value.find(folder => folder.isUncategorized))
const rootSelected = computed(() => !!rootFolder.value && folderSet.value.has(rootFolder.value.id))
const activeFolder = computed(() => folders.value.find(folder => folder.folderPath === folderPath.value))
const visibleFolders = computed(() => {
  const query = search.value.toLowerCase().trim()
  if (query) return folders.value.filter(folder => `${folder.name} ${folder.description} ${folder.folderPath}`.toLowerCase().includes(query))
  return folders.value.filter(folder => (folder.isUncategorized && folderPath.value === null) || (!folder.isUncategorized && parentPath(folder) === folderPath.value))
})
const activeProject = computed(() => projectsStore.get(chatStore.activeProjectId))
const visibleProjects = computed(() => {
  const query = search.value.toLowerCase().trim()
  return projectsStore.activeProjects.filter(project => !query || `${project.name} ${project.description}`.toLowerCase().includes(query))
})
const projectError = ref('')
async function chooseProject(projectId: string | null): Promise<void> {
  projectError.value = ''
  try {
    await chatStore.setConversationProject(projectId)
    close()
    void projectsStore.load()
  } catch (cause) {
    projectError.value = cause instanceof Error ? cause.message : String(cause)
  }
}
function newProject(): void {
  close()
  void router.push({ name: 'projects', query: { new: '1' } })
}
const changedFields = computed(() => new Set(chatStore.activeAgentId
  ? chatStore.agentOverrideFields : chatStore.freeChatOverrideFields))
function entryChanged(id: string): boolean {
  switch (id) {
    case 'tools': return changedFields.value.has('Tools')
    case 'memory': return changedFields.value.has('Memory folders')
    case 'agents': return changedFields.value.has('Sub-agents')
    case 'prompt': return changedFields.value.has('System prompt')
    case 'project': return Boolean(activeProject.value)
    default: return false
  }
}

function parentPath(folder: MemoryFolder): string | null {
  if (folder.isUncategorized) return null
  if (folder.parentFolderPath !== undefined) return folder.parentFolderPath || null
  const parts = folder.folderPath.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join('/') : null
}
function hasChildren(folder: MemoryFolder): boolean {
  return folders.value.some(item => !item.isUncategorized && parentPath(item) === folder.folderPath)
}
function folderSelected(folder: MemoryFolder): boolean {
  return isMemoryFolderSelected(folder, folderSet.value, rootSelected.value)
}
function toggleFolder(folder: MemoryFolder): void {
  const selected = new Set(chatStore.freeChatMemoryFolderIds)
  const scope = folder.isUncategorized ? [folder.id] : folders.value.filter(item => item.id === folder.id || item.folderPath.startsWith(`${folder.folderPath}/`)).map(item => item.id)
  if (folder.isUncategorized) {
    selected.clear()
    if (!rootSelected.value) selected.add(folder.id)
  } else if (rootSelected.value && isAutoExcludedMemoryFolder(folder)) {
    const remove = selected.has(folder.id)
    scope.forEach(id => remove ? selected.delete(id) : selected.add(id))
  } else if (rootSelected.value) {
    const remaining = folders.value.filter(item => !item.isUncategorized && folderSelected(item) && !scope.includes(item.id)).map(item => item.id)
    selected.clear()
    remaining.forEach(id => selected.add(id))
  } else if (selected.has(folder.id)) scope.forEach(id => selected.delete(id))
  else scope.forEach(id => selected.add(id))
  chatStore.freeChatMemoryFolderIds.splice(0, chatStore.freeChatMemoryFolderIds.length, ...selected)
  chatStore.freeChatMemorySelectionInitialized = true
  chatStore.markOverridesModified()
}
function toggleTool(tool: ToolInfo): void {
  const selected = new Set(chatStore.selectedToolNames)
  if (selected.has(tool.key)) selected.delete(tool.key)
  else selected.add(tool.key)
  chatStore.setSelectedToolNames([...selected])
}
function groupSelected(group: { tools: ToolInfo[] }): boolean {
  return group.tools.length > 0 && group.tools.every(tool => chatStore.selectedToolNames.includes(tool.key))
}
function groupSelectionState(group: { tools: ToolInfo[] }): boolean | 'mixed' {
  if (groupSelected(group)) return true
  return group.tools.some(tool => chatStore.selectedToolNames.includes(tool.key)) ? 'mixed' : false
}
function toggleGroup(group: { tools: ToolInfo[] }): void {
  const selected = new Set(chatStore.selectedToolNames)
  const shouldSelect = !groupSelected(group)
  for (const tool of group.tools) {
    if (shouldSelect) selected.add(tool.key)
    else selected.delete(tool.key)
  }
  chatStore.setSelectedToolNames([...selected])
}
function namespaceIcon(namespaceId: string): string | null {
  if (!namespaceId.startsWith('mcp:') || brokenMcpIcons.value.has(namespaceId)) return null
  return servers.value.find(server => server.id === namespaceId.slice(4))?.icon_url ?? null
}
function markIconBroken(namespaceId: string): void {
  brokenMcpIcons.value = new Set([...brokenMcpIcons.value, namespaceId])
}
function toggleAgent(id: string): void {
  const index = chatStore.freeChatSubAgentIds.indexOf(id)
  if (index < 0) chatStore.freeChatSubAgentIds.push(id)
  else chatStore.freeChatSubAgentIds.splice(index, 1)
  chatStore.markOverridesModified()
}
function setAutoTools(): void {
  chatStore.sessionAutoToolRouting = !chatStore.sessionAutoToolRouting
  chatStore.markOverridesModified()
}
function setAutoMemory(): void {
  chatStore.sessionAutoMemory = !chatStore.sessionAutoMemory
  chatStore.markOverridesModified()
}
function navigate(next: Panel): void {
  panel.value = next
  search.value = ''
  if (next === 'memory') void chatStore.loadMemoryFolders()
  if (next === 'tools' && !servers.value.length) void loadServers().catch(() => undefined)
  if (next === 'project') {
    projectError.value = ''
    void projectsStore.ensureLoaded().catch(() => undefined)
  }
}
function selectEntry(id: string): void {
  if (id === 'prompt') {
    close()
    showSystemPrompt.value = true
  } else navigate(id as Panel)
}
function close(): void {
  open.value = false
  panel.value = 'main'
  search.value = ''
  folderPath.value = null
  toolNamespace.value = null
}
function back(): void {
  if (panel.value === 'memory' && folderPath.value) folderPath.value = activeFolder.value ? parentPath(activeFolder.value) : null
  else if (panel.value === 'tools' && toolNamespace.value) toolNamespace.value = null
  else navigate('main')
  search.value = ''
}
function updatePosition(): void {
  const rect = root.value?.getBoundingClientRect()
  if (!rect) return
  const gap = 8
  const padding = 8
  const height = 520
  const above = Math.max(0, rect.top - gap - padding)
  const below = Math.max(0, window.innerHeight - rect.bottom - gap - padding)
  const useAbove = above >= Math.min(300, height) || above >= below
  const width = Math.min(360, window.innerWidth - padding * 2)
  menuStyle.value = {
    width: `${width}px`,
    left: `${Math.max(padding, Math.min(rect.left, window.innerWidth - width - padding))}px`,
    maxHeight: `${Math.min(height, useAbove ? above : below)}px`,
    ...(useAbove ? { bottom: `${window.innerHeight - rect.top + gap}px` } : { top: `${rect.bottom + gap}px` }),
  }
}
async function toggle(): Promise<void> {
  if (open.value) return close()
  open.value = true
  await nextTick()
  updatePosition()
}
function pickFile(kind: 'attach' | 'browseLibrary'): void {
  close()
  if (kind === 'attach') emit('attach')
  else emit('browseLibrary')
}
onClickOutside(root, close, { ignore: [menu] })
onMounted(() => {
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})
</script>

<template>
  <span
    ref="root"
    class="inline-flex shrink-0"
  >
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-full border border-theme-700 text-theme-300 transition-colors hover:border-theme-500 hover:bg-theme-700 hover:text-theme-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      :class="open ? 'bg-theme-700 text-theme-100' : ''"
      aria-label="Add and configure chat options"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon
        icon="lucide:plus"
        class="h-5 w-5"
      />
    </button>
  </span>

  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-theme-700 bg-theme-900 text-theme-200 shadow-2xl"
      :style="menuStyle"
      role="dialog"
      aria-label="Chat options"
      @keydown.esc.stop.prevent="panel === 'main' ? close() : back()"
    >
      <div
        v-if="panel !== 'main'"
        class="flex items-center gap-2 border-b border-theme-700 px-2 py-2"
      >
        <button
          type="button"
          class="rounded-lg p-1.5 hover:bg-theme-800"
          aria-label="Back to chat options"
          @click="back"
        >
          <Icon
            icon="lucide:chevron-left"
            class="h-4 w-4"
          />
        </button>
        <span class="text-xs font-semibold">{{ panel === 'tools' && toolNamespace ? toolGroups.find(group => group.id === toolNamespace)?.label : panel === 'memory' && activeFolder ? activeFolder.name : entries.find(item => item.id === panel)?.label }}</span>
      </div>
      <div
        v-if="panel !== 'main' && panel !== 'files'"
        class="border-b border-theme-800 p-2"
      >
        <label class="flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-800 px-2.5 py-2 focus-within:border-accent-500">
          <Icon
            icon="lucide:search"
            class="h-4 w-4 text-ink-muted"
          />
          <input
            v-model="search"
            type="search"
            class="min-w-0 flex-1 bg-transparent text-xs text-theme-100 outline-none placeholder:text-ink-muted"
            :placeholder="`Search ${panel === 'project' ? 'projects' : panel}…`"
            :aria-label="`Search ${panel === 'project' ? 'projects' : panel}`"
          >
        </label>
      </div>
      <div class="min-h-0 overflow-y-auto p-1.5">
        <template v-if="panel === 'main'">
          <template
            v-for="entry in entries"
            :key="entry.id"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left hover:bg-theme-800 focus-visible:bg-theme-800 focus-visible:outline-none"
              @click="selectEntry(entry.id)"
            >
              <Icon
                :icon="entry.icon"
                class="h-5 w-5 shrink-0"
                :class="entryChanged(entry.id) ? 'text-accent-fg' : 'text-theme-300'"
              />
              <span class="min-w-0 flex-1"><span
                class="block text-sm"
                :class="entryChanged(entry.id) ? 'text-accent-fg' : 'text-theme-100'"
              >{{ entry.label }}</span></span>
              <span
                v-if="entry.id === 'project' && activeProject"
                class="max-w-32 truncate text-[11px] text-ink-muted"
              >{{ activeProject.name }}</span>
              <Icon
                icon="lucide:chevron-right"
                class="h-4 w-4 text-ink-muted"
              />
            </button>
            <template v-if="entry.id === 'files'">
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-theme-800"
                role="switch"
                :aria-checked="chatStore.sessionAutoMemory"
                aria-label="Automatic memories"
                @click="setAutoMemory"
              >
                <Icon
                  icon="lucide:database-zap"
                  class="h-5 w-5"
                  :class="changedFields.has('Automatic memory') ? 'text-accent-fg' : 'text-theme-300'"
                /><span class="min-w-0 flex-1"><span
                  class="block text-sm"
                  :class="changedFields.has('Automatic memory') ? 'text-accent-fg' : ''"
                >Automatic Memories</span><span class="block text-[11px] text-ink-muted">Retrieve relevant memories</span></span><span
                  class="relative h-5 w-9 rounded-full transition-colors"
                  :class="chatStore.sessionAutoMemory ? 'bg-accent-600' : 'bg-theme-600'"
                ><span
                  class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
                  :class="chatStore.sessionAutoMemory ? 'left-4.5' : 'left-0.5'"
                /></span>
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-theme-800"
                role="switch"
                :aria-checked="chatStore.sessionAutoToolRouting"
                aria-label="Automatic tools"
                @click="setAutoTools"
              >
                <Icon
                  icon="lucide:sparkles"
                  class="h-5 w-5"
                  :class="changedFields.has('Automatic tool routing') ? 'text-accent-fg' : 'text-theme-300'"
                /><span class="min-w-0 flex-1"><span
                  class="block text-sm"
                  :class="changedFields.has('Automatic tool routing') ? 'text-accent-fg' : ''"
                >Automatic Tools</span><span class="block text-[11px] text-ink-muted">Auto-select the appropriate toolset</span></span><span
                  class="relative h-5 w-9 rounded-full transition-colors"
                  :class="chatStore.sessionAutoToolRouting ? 'bg-accent-600' : 'bg-theme-600'"
                ><span
                  class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
                  :class="chatStore.sessionAutoToolRouting ? 'left-4.5' : 'left-0.5'"
                /></span>
              </button>
            </template>
            <div
              v-if="entry.id === 'files'"
              class="mx-2 my-1 border-t border-theme-700/75"
              role="separator"
            />
          </template>
        </template>
        <template v-else-if="panel === 'files'">
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-xl px-2.5 py-3 text-left hover:bg-theme-800"
            @click="pickFile('attach')"
          >
            <Icon
              icon="lucide:upload"
              class="h-5 w-5"
            /><span class="flex-1"><span class="block text-sm">Upload files</span><span class="block text-[11px] text-ink-muted">Choose files from your device</span></span>
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-xl px-2.5 py-3 text-left hover:bg-theme-800"
            @click="pickFile('browseLibrary')"
          >
            <Icon
              icon="lucide:library"
              class="h-5 w-5"
            /><span class="flex-1"><span class="block text-sm">Select from library</span><span class="block text-[11px] text-ink-muted">Reuse a previous attachment</span></span>
          </button>
        </template>
        <template v-else-if="panel === 'tools'">
          <template v-if="!toolNamespace">
            <div
              v-for="group in toolGroups"
              :key="group.id"
              class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-theme-800"
              @click="toggleGroup(group)"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
                role="checkbox"
                :aria-checked="groupSelectionState(group)"
                :aria-label="`Select all tools in ${group.label}`"
              >
                <span
                  class="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                  :class="groupSelectionState(group) ? 'border-accent-500 accent-action bg-accent-500 text-accent-on' : 'border-theme-600 bg-theme-950'"
                >
                  <Icon
                    v-if="groupSelectionState(group)"
                    :icon="groupSelected(group) ? 'lucide:check' : 'lucide:minus'"
                    class="h-3 w-3"
                  />
                </span>
                <span class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-theme-800">
                  <img
                    v-if="namespaceIcon(group.id)"
                    :src="namespaceIcon(group.id)!"
                    alt=""
                    class="h-6 w-6 object-contain"
                    @error="markIconBroken(group.id)"
                  >
                  <Icon
                    v-else
                    :icon="getToolNamespaceIcon(group.id)"
                    class="h-4 w-4"
                    :class="isBuiltInNamespaceId(group.id) ? 'text-accent-fg' : 'text-ink-secondary'"
                  />
                </span>
                <span class="min-w-0 flex-1 truncate text-xs">{{ group.label }}</span>
              </button>
              <span class="text-[10px] text-ink-muted">{{ group.tools.filter(tool => chatStore.selectedToolNames.includes(tool.key)).length }}/{{ group.tools.length }}</span>
              <button
                type="button"
                class="rounded p-1 text-ink-muted hover:bg-theme-700 hover:text-theme-200"
                :aria-label="`Open ${group.label} tools`"
                @click.stop="toolNamespace = group.id; search = ''"
              >
                <Icon
                  icon="lucide:chevron-right"
                  class="h-4 w-4"
                />
              </button>
            </div>
            <div
              v-if="!toolGroups.length"
              class="px-3 py-5 text-center text-xs text-ink-muted"
            >
              No tools found
            </div>
          </template>
          <template v-else>
            <label
              v-for="tool in activeTools"
              :key="tool.key"
              class="flex cursor-pointer gap-2.5 rounded-lg px-2.5 py-2 hover:bg-theme-800"
            ><input
              type="checkbox"
              class="mt-0.5 h-4 w-4 accent-accent-500"
              :checked="chatStore.selectedToolNames.includes(tool.key)"
              @change="toggleTool(tool)"
            ><span class="min-w-0"><span class="block truncate text-xs">{{ tool.name }}</span><span class="block text-[10px] text-ink-muted">{{ tool.description.replace(/^\[MCP:\s*[^\]]*\]\s*/, '') }}</span></span></label>
            <div
              v-if="!activeTools.length"
              class="px-3 py-5 text-center text-xs text-ink-muted"
            >
              No tools found
            </div>
          </template>
        </template>
        <template v-else-if="panel === 'memory'">
          <div
            v-for="folder in visibleFolders"
            :key="folder.id"
            class="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-theme-800"
          >
            <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2"><input
              type="checkbox"
              class="h-4 w-4 accent-accent-500"
              :checked="folderSelected(folder)"
              @change="toggleFolder(folder)"
            ><Icon
              icon="lucide:folder"
              class="h-4 w-4 text-ink-secondary"
            /><span class="min-w-0"><span class="block truncate text-xs">{{ folder.isUncategorized ? 'All Memory' : folder.name }}</span><span class="block text-[10px] text-ink-muted">{{ folder.isUncategorized ? 'Uncategorized and standard folders' : `${folder.fileCount} documents` }}</span></span></label><button
              v-if="hasChildren(folder)"
              type="button"
              class="rounded p-1 hover:bg-theme-700"
              :aria-label="`Open ${folder.name}`"
              @click="folderPath = folder.folderPath; search = ''"
            >
              <Icon
                icon="lucide:chevron-right"
                class="h-4 w-4"
              />
            </button>
          </div>
          <div
            v-if="!visibleFolders.length"
            class="px-3 py-5 text-center text-xs text-ink-muted"
          >
            No memory folders found
          </div>
        </template>
        <template v-else-if="panel === 'project'">
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-theme-800"
            role="menuitemradio"
            :aria-checked="!activeProject"
            @click="chooseProject(null)"
          >
            <Icon
              icon="lucide:circle-off"
              class="h-4 w-4 shrink-0 text-ink-muted"
            />
            <span class="min-w-0 flex-1 text-xs">No project</span>
            <Icon
              v-if="!activeProject"
              icon="lucide:check"
              class="h-4 w-4 text-accent-fg"
            />
          </button>
          <button
            v-for="project in visibleProjects"
            :key="project.id"
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-theme-800"
            role="menuitemradio"
            :aria-checked="project.id === chatStore.activeProjectId"
            @click="chooseProject(project.id)"
          >
            <span class="flex h-4 w-4 shrink-0 items-center justify-center"><span
              class="h-2.5 w-2.5 rounded-full"
              :style="{ backgroundColor: project.color || 'var(--color-accent-500)' }"
            /></span>
            <span class="min-w-0 flex-1"><span class="block truncate text-xs">{{ project.name }}</span><span
              v-if="project.description"
              class="block truncate text-[10px] text-ink-muted"
            >{{ project.description }}</span></span>
            <Icon
              v-if="project.id === chatStore.activeProjectId"
              icon="lucide:check"
              class="h-4 w-4 text-accent-fg"
            />
          </button>
          <div
            v-if="!visibleProjects.length"
            class="px-3 py-3 text-center text-xs text-ink-muted"
          >
            No projects found
          </div>
          <p
            v-if="projectError"
            role="alert"
            class="px-3 py-2 text-xs text-status-danger"
          >
            {{ projectError }}
          </p>
          <div class="mx-2 my-1 border-t border-theme-700/75" />
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-theme-800"
            @click="newProject"
          >
            <Icon
              icon="lucide:plus"
              class="h-4 w-4 text-ink-muted"
            />
            New project…
          </button>
        </template>
        <template v-else-if="panel === 'agents'">
          <label
            v-for="agent in visibleAgents"
            :key="agent.id"
            class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-theme-800"
          ><input
            type="checkbox"
            class="h-4 w-4 accent-accent-500"
            :checked="chatStore.freeChatSubAgentIds.includes(agent.id)"
            @change="toggleAgent(agent.id)"
          ><img
            v-if="agent.iconUrl"
            :src="agent.iconUrl"
            alt=""
            class="h-4 w-4 shrink-0 rounded-sm object-cover"
          ><Icon
            v-else
            icon="lucide:bot"
            class="h-4 w-4 shrink-0"
          /><span class="min-w-0"><span class="block truncate text-xs">{{ agent.name }}</span><span class="block truncate text-[10px] text-ink-muted">{{ agent.description || agent.internalName }}</span></span></label>
          <div
            v-if="!visibleAgents.length"
            class="px-3 py-5 text-center text-xs text-ink-muted"
          >
            No subagents found
          </div>
        </template>
      </div>
    </div>
  </Teleport>
  <SystemPromptModal
    v-model="showSystemPrompt"
    :system-prompt="chatStore.sessionSystemPrompt"
    @update:system-prompt="(value: string) => { chatStore.sessionSystemPrompt = value; chatStore.markOverridesModified() }"
  />
</template>
