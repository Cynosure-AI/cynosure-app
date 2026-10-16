<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { ProjectTaskDto } from '@shared/types'
import type { AgentDefinition } from '../../api/types'

export interface TaskContextMenu {
  task: ProjectTaskDto
  x: number
  y: number
}

const props = defineProps<{
  menu: TaskContextMenu | null
  agents: AgentDefinition[]
}>()

const emit = defineEmits<{
  close: []
  run: [task: ProjectTaskDto]
  assign: [task: ProjectTaskDto, agentId: string | null]
  done: [task: ProjectTaskDto]
  delete: [task: ProjectTaskDto]
}>()

const EDGE = 8
/** How long the agent list survives the pointer crossing other items on its way there. */
const AGENTS_CLOSE_DELAY = 300

const menuRef = ref<HTMLElement | null>(null)
const assignRef = ref<HTMLElement | null>(null)
const position = ref({ left: 0, top: 0 })
const agentsOpen = ref(false)
const agentsStyle = ref<Record<string, string>>({})
let agentsCloseTimer: ReturnType<typeof setTimeout> | null = null

/** Same order as the agent picker: favorites first, then the user's order. */
const sortedAgents = computed(() => [...props.agents].sort((a, b) => {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
}))

function items(container: HTMLElement | null): HTMLElement[] {
  return container ? [...container.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not(:disabled), :scope > [role="menuitemradio"]')] : []
}

/** Keep the menu inside the window, measured once it has rendered. */
async function place(): Promise<void> {
  if (!props.menu) return
  position.value = { left: props.menu.x, top: props.menu.y }
  await nextTick()
  const el = menuRef.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  position.value = {
    left: Math.max(EDGE, Math.min(props.menu.x, window.innerWidth - width - EDGE)),
    top: Math.max(EDGE, Math.min(props.menu.y, window.innerHeight - height - EDGE)),
  }
  items(el)[0]?.focus()
}

/** The agent list opens beside the menu, on whichever side has room. */
async function openAgents(focus = false): Promise<void> {
  cancelCloseAgents()
  agentsOpen.value = true
  await nextTick()
  const trigger = assignRef.value?.getBoundingClientRect()
  const list = document.querySelector<HTMLElement>('[data-task-agent-menu]')
  if (!trigger || !list) return
  const { width, height } = list.getBoundingClientRect()
  const right = trigger.right + width + EDGE <= window.innerWidth
  agentsStyle.value = {
    left: `${right ? trigger.right - 4 : Math.max(EDGE, trigger.left - width + 4)}px`,
    top: `${Math.max(EDGE, Math.min(trigger.top - 4, window.innerHeight - height - EDGE))}px`,
  }
  if (focus) (list.querySelector<HTMLElement>('[aria-checked="true"]') ?? items(list)[0])?.focus()
}

function closeAgents(refocus = false): void {
  cancelCloseAgents()
  agentsOpen.value = false
  if (refocus) assignRef.value?.focus()
}

function cancelCloseAgents(): void {
  if (agentsCloseTimer) clearTimeout(agentsCloseTimer)
  agentsCloseTimer = null
}

function scheduleCloseAgents(): void {
  if (!agentsOpen.value || agentsCloseTimer) return
  agentsCloseTimer = setTimeout(() => closeAgents(), AGENTS_CLOSE_DELAY)
}

function pick(action: () => void): void {
  action()
  emit('close')
}

function onKeydown(event: KeyboardEvent, container: 'menu' | 'agents'): void {
  const list = container === 'menu' ? items(menuRef.value) : items(document.querySelector('[data-task-agent-menu]'))
  const index = list.indexOf(document.activeElement as HTMLElement)
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    list[(index + step + list.length) % list.length]?.focus()
  } else if (container === 'menu' && event.key === 'ArrowRight' && document.activeElement === assignRef.value) {
    event.preventDefault()
    void openAgents(true)
  } else if (container === 'agents' && event.key === 'ArrowLeft') {
    event.preventDefault()
    closeAgents(true)
  }
}

function onPointerDown(event: MouseEvent): void {
  if (!(event.target as HTMLElement).closest('[data-task-context-menu]')) emit('close')
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.menu) return
  if (agentsOpen.value) closeAgents(true)
  else emit('close')
}

function onDismiss(event: Event): void {
  // Scrolling the menus themselves (the agent list) keeps them open; scrolling the page would strand them.
  if (event.target instanceof Element && event.target.closest('[data-task-context-menu]')) return
  if (props.menu) emit('close')
}

watch(() => props.menu, (menu) => {
  closeAgents()
  if (menu) void place()
})

onMounted(() => {
  document.addEventListener('mousedown', onPointerDown)
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('resize', onDismiss)
  window.addEventListener('scroll', onDismiss, true)
})
onBeforeUnmount(() => {
  cancelCloseAgents()
  document.removeEventListener('mousedown', onPointerDown)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('resize', onDismiss)
  window.removeEventListener('scroll', onDismiss, true)
})
</script>

<template>
  <Teleport to="body">
    <template v-if="menu">
      <div
        ref="menuRef"
        data-task-context-menu
        data-testid="task-context-menu"
        class="fixed z-80 w-52 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-2xl shadow-black/50"
        :style="{ left: `${position.left}px`, top: `${position.top}px` }"
        role="menu"
        :aria-label="`Actions for ${menu.task.title}`"
        @contextmenu.prevent
        @keydown="onKeydown($event, 'menu')"
      >
        <div class="truncate border-b border-theme-800 px-3 py-2 text-[11px] text-ink-muted">
          {{ menu.task.title }}
        </div>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800 focus:bg-theme-800 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          role="menuitem"
          :disabled="menu.task.status === 'done'"
          :title="menu.task.status === 'done' ? 'This task is already done' : 'Start a chat for this task'"
          @click="pick(() => emit('run', menu!.task))"
          @mouseenter="scheduleCloseAgents"
        >
          <Icon
            icon="lucide:play"
            class="h-3.5 w-3.5 text-accent-fg"
          /> Run
        </button>
        <button
          ref="assignRef"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800 focus:bg-theme-800 focus:outline-none"
          :class="{ 'bg-theme-800': agentsOpen }"
          role="menuitem"
          aria-haspopup="menu"
          :aria-expanded="agentsOpen"
          @click="agentsOpen ? closeAgents() : openAgents(true)"
          @mouseenter="openAgents()"
        >
          <Icon
            icon="lucide:bot"
            class="h-3.5 w-3.5"
          /> Assign agent
          <Icon
            icon="lucide:chevron-right"
            class="ml-auto h-3.5 w-3.5 text-ink-muted"
          />
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800 focus:bg-theme-800 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          role="menuitem"
          :disabled="menu.task.status === 'done'"
          @click="pick(() => emit('done', menu!.task))"
          @mouseenter="scheduleCloseAgents"
        >
          <Icon
            icon="lucide:circle-check"
            class="h-3.5 w-3.5 text-status-success"
          /> Mark as done
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-left text-xs text-red-300 hover:bg-red-500/10 focus:bg-red-500/10 focus:outline-none"
          role="menuitem"
          @click="pick(() => emit('delete', menu!.task))"
          @mouseenter="scheduleCloseAgents"
        >
          <Icon
            icon="lucide:trash-2"
            class="h-3.5 w-3.5"
          /> Delete
        </button>
      </div>

      <div
        v-if="agentsOpen"
        data-task-context-menu
        data-task-agent-menu
        class="fixed z-81 max-h-72 w-56 overflow-y-auto rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-2xl shadow-black/50"
        :style="agentsStyle"
        role="menu"
        aria-label="Assign agent"
        @mouseenter="cancelCloseAgents"
        @contextmenu.prevent
        @keydown="onKeydown($event, 'agents')"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800 focus:bg-theme-800 focus:outline-none"
          role="menuitemradio"
          :aria-checked="!menu.task.assigneeAgentId"
          @click="pick(() => emit('assign', menu!.task, null))"
        >
          <Icon
            icon="lucide:message-square"
            class="h-3.5 w-3.5 shrink-0"
          />
          <span class="truncate">Project default</span>
          <Icon
            v-if="!menu.task.assigneeAgentId"
            icon="lucide:check"
            class="ml-auto h-3.5 w-3.5 shrink-0 text-accent-fg"
          />
        </button>
        <div
          v-if="sortedAgents.length"
          class="my-1 border-t border-theme-800"
          role="separator"
        />
        <button
          v-for="agent in sortedAgents"
          :key="agent.id"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800 focus:bg-theme-800 focus:outline-none"
          role="menuitemradio"
          :aria-checked="menu.task.assigneeAgentId === agent.id"
          :title="agent.description || undefined"
          @click="pick(() => emit('assign', menu!.task, agent.id))"
        >
          <img
            v-if="agent.iconUrl"
            :src="agent.iconUrl"
            alt=""
            class="h-3.5 w-3.5 shrink-0 rounded object-cover"
          >
          <Icon
            v-else
            icon="lucide:bot"
            class="h-3.5 w-3.5 shrink-0"
          />
          <span class="truncate">{{ agent.name }}</span>
          <Icon
            v-if="menu.task.assigneeAgentId === agent.id"
            icon="lucide:check"
            class="ml-auto h-3.5 w-3.5 shrink-0 text-accent-fg"
          />
        </button>
      </div>
    </template>
  </Teleport>
</template>
