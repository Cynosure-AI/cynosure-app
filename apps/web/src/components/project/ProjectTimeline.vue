<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import type { ProjectBriefRevisionDto, ProjectDiffSegment, ProjectDto, ProjectTimelineEntry } from '@shared/types'
import { api } from '../../api/client'
import MemoryInlineDiff from '../memory/MemoryInlineDiff.vue'
import RichContent from '../shared/RichContent.vue'
import ModalDialog from '../shared/ModalDialog.vue'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useChatStore } from '../../stores/chat.store'
import { TASK_COLUMNS } from '../../utils/project-format'

type BriefEntry = Extract<ProjectTimelineEntry, { kind: 'brief' }>
type ViewMode = 'changes' | 'since' | 'text'

const props = defineProps<{ project: ProjectDto }>()
const emit = defineEmits<{ restored: [] }>()

const router = useRouter()
const agentDefs = useAgentDefinitionsStore()
const chatStore = useChatStore()

const entries = ref<ProjectTimelineEntry[]>([])
const hasMore = ref(false)
const loading = ref(false)
const error = ref('')
const selectedId = ref<string | null>(null)
const revision = ref<ProjectBriefRevisionDto | null>(null)
const segments = ref<ProjectDiffSegment[]>([])
const mode = ref<ViewMode>('changes')
const confirmRestore = ref(false)
const cleanups: Array<() => void> = []
let refreshTimer: ReturnType<typeof setTimeout> | null = null

const PAGE_SIZE = 50
const briefEntries = computed(() => entries.value.filter((entry): entry is BriefEntry => entry.kind === 'brief'))
const currentRevision = computed(() => briefEntries.value.find((entry) => entry.isCurrent))
const selected = computed(() => briefEntries.value.find((entry) => entry.id === selectedId.value) ?? null)
const days = computed(() => {
  const groups: Array<{ label: string; entries: ProjectTimelineEntry[] }> = []
  for (const entry of entries.value) {
    const label = dayLabel(entry.createdAt)
    const last = groups.at(-1)
    if (last?.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }
  return groups
})

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function time(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function actor(entry: ProjectTimelineEntry): string {
  if (entry.source === 'dream') return 'Dream'
  if (entry.source === 'initial') return 'Before history'
  if (entry.source === 'user' || entry.source === 'restore') return entry.kind === 'chat_started' && entry.agentId ? agentName(entry.agentId) : 'You'
  return agentName(entry.agentId)
}

function agentName(agentId: string | null): string {
  return agentId ? (agentDefs.get(agentId)?.name ?? 'Agent') : 'Free Chat'
}

function statusLabel(status: string | null): string {
  return TASK_COLUMNS.find((column) => column.status === status)?.label ?? status ?? ''
}

function describe(entry: ProjectTimelineEntry): { icon: string; tone: string; text: string } {
  switch (entry.kind) {
    case 'brief':
      return {
        icon: entry.source === 'restore' ? 'lucide:history' : 'lucide:file-pen-line',
        tone: entry.source === 'dream' ? 'text-status-indigo' : 'text-accent-fg',
        text: entry.source === 'restore' ? `Restored an earlier brief as revision ${entry.revisionNumber}` : entry.source === 'initial' ? 'Original brief' : `Updated the brief (revision ${entry.revisionNumber})`,
      }
    case 'task_created':
      return { icon: 'lucide:square-plus', tone: 'text-ink-secondary', text: `Added task “${entry.taskTitle}”` }
    case 'task_deleted':
      return { icon: 'lucide:square-x', tone: 'text-ink-muted', text: `Removed task “${entry.taskTitle}”` }
    case 'task_updated':
      return entry.fromStatus !== entry.toStatus
        ? {
          icon: entry.toStatus === 'done' ? 'lucide:circle-check' : entry.toStatus === 'blocked' ? 'lucide:circle-alert' : 'lucide:arrow-right-left',
          tone: entry.toStatus === 'done' ? 'text-status-success' : entry.toStatus === 'blocked' ? 'text-status-warning' : 'text-status-info',
          text: `Moved “${entry.taskTitle}” to ${statusLabel(entry.toStatus)}`,
        }
        : { icon: 'lucide:pencil', tone: 'text-ink-secondary', text: `Renamed a task to “${entry.taskTitle}”` }
    case 'chat_started':
      return { icon: entry.origin === 'cron' ? 'lucide:calendar-clock' : 'lucide:message-square-plus', tone: 'text-ink-secondary', text: entry.origin === 'cron' ? 'Scheduled run started' : 'Started a chat' }
  }
}

async function guarded(action: () => Promise<void>): Promise<void> {
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function load(reset = true): Promise<void> {
  loading.value = true
  await guarded(async () => {
    const before = reset ? undefined : entries.value.at(-1)?.createdAt
    const page = await api.projects.timeline(props.project.id, before)
    entries.value = reset ? page : [...entries.value, ...page]
    hasMore.value = page.length === PAGE_SIZE
    if (!selected.value) selectedId.value = currentRevision.value?.id ?? briefEntries.value[0]?.id ?? null
  })
  loading.value = false
}

async function loadSelection(): Promise<void> {
  const entry = selected.value
  if (!entry) {
    revision.value = null
    segments.value = []
    return
  }
  // "Since" compares the selected brief with today's; for the current brief that is empty, so show its changes.
  if (mode.value === 'since' && entry.isCurrent) mode.value = 'changes'
  await guarded(async () => {
    const id = props.project.id
    const [detail, diff] = await Promise.all([
      api.projects.getBriefRevision(id, entry.id),
      mode.value === 'text'
        ? Promise.resolve({ segments: [] })
        : mode.value === 'since' && currentRevision.value
          ? api.projects.diffBriefRevision(id, currentRevision.value.id, entry.id)
          : api.projects.diffBriefRevision(id, entry.id),
    ])
    if (selected.value?.id !== entry.id) return
    revision.value = detail
    segments.value = diff.segments
  })
}

async function restore(): Promise<void> {
  confirmRestore.value = false
  const entry = selected.value
  if (!entry) return
  await guarded(async () => {
    await api.projects.restoreBriefRevision(props.project.id, entry.id)
    selectedId.value = null
    await load()
    emit('restored')
  })
}

async function openChat(entry: ProjectTimelineEntry): Promise<void> {
  if (!entry.conversationId) return
  await chatStore.selectConversation(entry.conversationId, entry.agentId)
  await router.push({ name: 'conversation', params: { conversationId: entry.conversationId } })
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    // Follow the newest brief when the current one was selected; keep an older selection.
    if (selected.value?.isCurrent) selectedId.value = null
    void load()
  }, 300)
}

watch([selectedId, mode], () => { void loadSelection() })
watch(() => props.project.id, () => {
  selectedId.value = null
  void load()
})

onMounted(() => {
  cleanups.push(
    api.projects.onUpdated(({ id }) => { if (id === props.project.id) scheduleRefresh() }),
    api.projects.onTasksUpdated(({ projectId }) => { if (projectId === props.project.id) scheduleRefresh() }),
  )
  void load()
})

onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
  cleanups.forEach((cleanup) => cleanup())
})
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
    <section aria-label="Project timeline">
      <p
        v-if="error"
        role="alert"
        class="mb-3 rounded-lg bg-status-danger/10 px-3 py-2 text-sm text-status-danger"
      >
        {{ error }}
      </p>
      <p
        v-if="!loading && !entries.length"
        class="rounded-xl border border-dashed border-theme-700 px-6 py-10 text-center text-sm text-ink-muted"
      >
        Nothing has happened in this project yet.
      </p>

      <div
        v-for="day in days"
        :key="day.label"
        class="mb-5"
      >
        <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          {{ day.label }}
        </h3>
        <ol class="relative space-y-1 border-l border-theme-800 pl-4">
          <li
            v-for="entry in day.entries"
            :key="entry.id"
            class="relative"
          >
            <span
              class="absolute -left-[1.4rem] top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-theme-950 ring-1 ring-theme-800"
              aria-hidden="true"
            >
              <Icon
                :icon="describe(entry).icon"
                class="h-3 w-3"
                :class="describe(entry).tone"
              />
            </span>
            <component
              :is="entry.kind === 'brief' ? 'button' : 'div'"
              :type="entry.kind === 'brief' ? 'button' : undefined"
              class="block w-full rounded-lg px-3 py-2 text-left transition-colors"
              :class="entry.kind === 'brief'
                ? (entry.id === selectedId ? 'bg-theme-800 ring-1 ring-accent-500/40' : 'hover:bg-theme-800/60')
                : ''"
              :aria-pressed="entry.kind === 'brief' ? entry.id === selectedId : undefined"
              @click="entry.kind === 'brief' && (selectedId = entry.id)"
            >
              <span class="flex items-start gap-2">
                <span class="min-w-0 flex-1 text-sm text-theme-200">{{ describe(entry).text }}</span>
                <span
                  v-if="entry.kind === 'brief' && entry.isCurrent"
                  class="shrink-0 rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-fg"
                >Current</span>
                <span class="shrink-0 text-[11px] text-ink-faint">{{ time(entry.createdAt) }}</span>
              </span>
              <span class="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-ink-muted">
                <span class="shrink-0">{{ actor(entry) }}</span>
                <template v-if="entry.conversationId && entry.conversationTitle">
                  <span>·</span>
                  <a
                    href="#"
                    class="truncate hover:text-theme-200 hover:underline"
                    @click.prevent.stop="openChat(entry)"
                  >{{ entry.conversationTitle }}</a>
                </template>
              </span>
            </component>
          </li>
        </ol>
      </div>

      <button
        v-if="hasMore"
        type="button"
        class="w-full rounded-lg border border-theme-800 py-2 text-xs text-ink-muted hover:bg-theme-800 hover:text-theme-200 disabled:opacity-50"
        :disabled="loading"
        @click="load(false)"
      >
        Load older
      </button>
    </section>

    <section
      class="lg:sticky lg:top-44 lg:self-start"
      aria-label="Brief revision"
    >
      <div
        v-if="!selected"
        class="rounded-xl border border-dashed border-theme-700 px-6 py-10 text-center text-sm text-ink-muted"
      >
        Brief revisions appear here. Select one in the timeline to see what changed.
      </div>
      <div
        v-else
        class="flex flex-col gap-3"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-theme-100">
              Brief, revision {{ selected.revisionNumber }}
            </h3>
            <p class="mt-0.5 text-xs text-ink-muted">
              {{ actor(selected) }} · {{ new Date(selected.createdAt).toLocaleString() }}
            </p>
          </div>
          <button
            v-if="!selected.isCurrent"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 px-3 py-1.5 text-xs text-theme-300 hover:bg-theme-800"
            @click="confirmRestore = true"
          >
            <Icon
              icon="lucide:history"
              class="h-3.5 w-3.5"
            />
            Restore this version
          </button>
        </div>

        <div
          class="flex gap-1 text-xs"
          role="tablist"
          aria-label="Revision view"
        >
          <button
            v-for="option in [
              { value: 'changes', label: 'What changed' },
              ...(selected.isCurrent ? [] : [{ value: 'since', label: 'Changes since then' }]),
              { value: 'text', label: 'Full text' },
            ] as Array<{ value: ViewMode; label: string }>"
            :key="option.value"
            type="button"
            role="tab"
            :aria-selected="mode === option.value"
            class="rounded-md px-2.5 py-1 transition-colors"
            :class="mode === option.value ? 'bg-theme-800 text-theme-100' : 'text-ink-muted hover:text-theme-200'"
            @click="mode = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <p class="text-[11px] text-ink-faint">
          {{ mode === 'changes'
            ? 'Changes this update made to the previous brief.'
            : mode === 'since'
              ? 'How the brief has changed from this version to the current one.'
              : 'The brief exactly as it was at this point.' }}
        </p>

        <div
          v-if="mode === 'text'"
          class="max-h-[60vh] overflow-y-auto rounded-xl border border-theme-800/80 bg-theme-950/70 p-4 text-sm text-theme-200"
        >
          <RichContent
            v-if="revision?.content"
            :content="revision.content"
          />
          <p
            v-else
            class="text-ink-muted"
          >
            The brief was empty.
          </p>
        </div>
        <div
          v-else
          class="max-h-[60vh] min-h-0 overflow-hidden"
        >
          <MemoryInlineDiff :segments="segments" />
        </div>
      </div>
    </section>

    <ModalDialog
      :show="confirmRestore"
      title="Restore this brief?"
      icon="lucide:history"
      @close="confirmRestore = false"
    >
      <p class="text-sm text-theme-300">
        Revision {{ selected?.revisionNumber }} becomes the current brief that every chat and agent in this project starts from. The current brief stays in the history, so you can switch back.
      </p>
      <template #actions>
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
          @click="confirmRestore = false"
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-lg accent-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on hover:bg-accent-400"
          @click="restore"
        >
          Restore
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
