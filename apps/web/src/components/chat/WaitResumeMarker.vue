<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api, type PendingWait } from '../../api/client'
import { wsConnected } from '../../api/http'

const props = defineProps<{
  conversationId: string
}>()

const wait = ref<PendingWait | null>(null)
const now = ref(Date.now())
let requestToken = 0
let clock: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined

async function load(): Promise<void> {
  const token = ++requestToken
  try {
    const pending = await api.chat.getPendingWait(props.conversationId)
    if (token === requestToken) wait.value = pending
  } catch {
    // Keep the last known wait until the next change notification
  }
}

const remaining = computed(() => {
  if (!wait.value) return ''
  const minutes = Math.ceil((wait.value.resumesAt - now.value) / 60_000)
  if (minutes <= 1) return 'in under a minute'
  return `in ${minutes} minutes`
})

const resumeTime = computed(() =>
  wait.value ? new Date(wait.value.resumesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
)

watch(() => props.conversationId, () => {
  wait.value = null
  void load()
})

watch(wsConnected, (connected) => {
  if (connected) void load()
})

onMounted(() => {
  unsubscribe = api.chat.onWaitsChanged(() => void load())
  clock = setInterval(() => { now.value = Date.now() }, 15_000)
  void load()
})

onBeforeUnmount(() => {
  requestToken++
  if (clock) clearInterval(clock)
  unsubscribe?.()
})
</script>

<template>
  <div
    v-if="wait"
    class="px-4 py-2"
    data-testid="wait-resume-marker"
  >
    <div class="ml-0 flex max-w-[85%] items-center gap-3 md:ml-12">
      <div class="h-px flex-1 bg-linear-to-r from-transparent to-status-info/25" />
      <div
        class="flex min-w-0 shrink items-center gap-2 rounded-full border border-status-info/25 bg-status-info/8 px-3 py-1.5 text-xs text-status-info shadow-sm"
        :title="`Resumes at ${resumeTime}: ${wait.note}`"
      >
        <Icon
          icon="lucide:hourglass"
          class="h-3.5 w-3.5 shrink-0"
        />
        <span class="shrink-0 font-medium">Waiting · continues {{ remaining }}</span>
        <span class="hidden min-w-0 truncate text-ink-muted sm:inline">· {{ wait.note }}</span>
      </div>
      <div class="h-px flex-1 bg-linear-to-l from-transparent to-status-info/25" />
    </div>
  </div>
</template>
