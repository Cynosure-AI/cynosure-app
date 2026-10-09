<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import AgentSelect from '../shared/AgentSelect.vue'
import CustomSelect, { type SelectOptionGroup } from '../shared/CustomSelect.vue'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useChatStore } from '../../stores/chat.store'
import { PROJECT_COLORS } from '../../stores/projects.store'

export interface ProjectDraft {
  name: string
  description: string
  instructions: string
  rootPath: string
  defaultAgentId: string
  color: string
  /** Memory folder id; '' means none. Only shown when `showMemoryFolder` is set. */
  memoryFolderId: string
  createMemoryFolder: boolean
}

const props = defineProps<{
  showInstructions?: boolean
  /** New projects get their own folder by default; existing ones pick a folder. */
  mode: 'create' | 'edit'
}>()

const draft = defineModel<ProjectDraft>({ required: true })

const agentDefs = useAgentDefinitionsStore()
const chatStore = useChatStore()
const electron = (window as unknown as { electron?: { chooseFileAccessDirectory?: () => Promise<string | null> } }).electron
const inputClass = 'w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500'

const memoryFolderOptions = computed<SelectOptionGroup[]>(() => [{
  options: [
    { value: '', label: 'No memory folder', iconName: 'lucide:circle-off' },
    ...chatStore.memoryFolders.map((folder) => ({
      value: folder.id,
      label: folder.folderPath || folder.name,
      iconName: 'lucide:folder',
    })),
  ],
}])

async function chooseFolder(): Promise<void> {
  const selected = await electron?.chooseFileAccessDirectory?.()
  if (selected) draft.value.rootPath = selected
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <label
        for="project-name"
        class="mb-1.5 block text-sm text-ink-secondary"
      >Name</label>
      <input
        id="project-name"
        v-model="draft.name"
        type="text"
        required
        maxlength="80"
        placeholder="e.g. Website relaunch"
        :class="inputClass"
      >
    </div>

    <div>
      <label
        for="project-description"
        class="mb-1.5 block text-sm text-ink-secondary"
      >Description</label>
      <textarea
        id="project-description"
        v-model="draft.description"
        rows="2"
        placeholder="One or two sentences about the goal"
        :class="[inputClass, 'resize-none']"
      />
    </div>

    <div v-if="props.showInstructions">
      <label
        for="project-instructions"
        class="mb-1.5 block text-sm text-ink-secondary"
      >Instructions</label>
      <p class="mb-2 text-xs text-ink-faint">
        Added to the system prompt of every chat, sub-agent, and scheduled job in this project.
      </p>
      <textarea
        id="project-instructions"
        v-model="draft.instructions"
        rows="6"
        placeholder="Conventions, tone, constraints, links the agents should know about…"
        :class="[inputClass, 'font-mono text-xs leading-relaxed']"
      />
    </div>

    <div>
      <label
        for="project-directory"
        class="mb-1.5 block text-sm text-ink-secondary"
      >Project folder <span class="text-ink-faint">(optional)</span></label>
      <p class="mb-2 text-xs text-ink-faint">
        File tools in this project can use this folder without asking, and shell commands start there.
      </p>
      <div class="flex gap-2">
        <input
          id="project-directory"
          v-model="draft.rootPath"
          type="text"
          placeholder="Absolute folder path"
          :class="[inputClass, 'font-mono']"
        >
        <button
          v-if="electron?.chooseFileAccessDirectory"
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-theme-700 px-3 text-sm text-theme-300 hover:bg-theme-800"
          @click="chooseFolder"
        >
          <Icon
            icon="lucide:folder-open"
            class="h-4 w-4"
          />
          Browse
        </button>
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div>
        <span class="mb-1.5 block text-sm text-ink-secondary">Default agent</span>
        <AgentSelect
          v-model="draft.defaultAgentId"
          :agents="agentDefs.agents"
          include-default
          default-label="Free Chat"
          agents-group-label="Agents"
          size="sm"
        />
      </div>

      <div v-if="props.mode === 'edit'">
        <span class="mb-1.5 block text-sm text-ink-secondary">Memory folder</span>
        <CustomSelect
          v-model="draft.memoryFolderId"
          :groups="memoryFolderOptions"
          filterable
          size="sm"
        />
      </div>
      <label
        v-else
        class="flex items-start gap-2 self-end rounded-lg border border-theme-800 bg-theme-900/50 px-3 py-2 text-sm text-theme-300"
      >
        <input
          v-model="draft.createMemoryFolder"
          type="checkbox"
          class="mt-0.5 accent-[var(--color-accent-500)]"
        >
        <span>
          Create a memory folder
          <span class="block text-xs text-ink-faint">Projects/{{ draft.name.trim() || '…' }}</span>
        </span>
      </label>
    </div>

    <div>
      <span class="mb-1.5 block text-sm text-ink-secondary">Color</span>
      <div
        class="flex flex-wrap gap-2"
        role="radiogroup"
        aria-label="Project color"
      >
        <button
          v-for="color in PROJECT_COLORS"
          :key="color"
          type="button"
          role="radio"
          :aria-checked="draft.color === color"
          :aria-label="color"
          class="h-7 w-7 rounded-full ring-offset-2 ring-offset-theme-900 transition"
          :class="draft.color === color ? 'ring-2 ring-theme-200' : 'hover:scale-110'"
          :style="{ backgroundColor: color }"
          @click="draft.color = color"
        />
      </div>
    </div>
  </div>
</template>
