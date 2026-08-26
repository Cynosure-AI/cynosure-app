import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api/client'
import type { MemoryIndexJob } from '../api/types'

export const useMemoryJobsStore = defineStore('memory-jobs', () => {
    const jobs = ref<MemoryIndexJob[]>([])
    const loaded = ref(false)
    const refreshing = ref(false)
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const activeJobs = computed(() => jobs.value.filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'retrying'))
    const runningJobs = computed(() => jobs.value.filter(job => job.status === 'running' || job.status === 'retrying'))
    const runningReindexJobs = computed(() => activeJobs.value.filter(job => job.kind === 'reindex'))
    const runningKnowledgeExtractionJobs = computed(() => activeJobs.value.filter(job => job.kind === 'knowledge-extraction'))
    const hasRunningJobs = computed(() => activeJobs.value.length > 0)
    const statusLabel = computed(() => {
        if (runningKnowledgeExtractionJobs.value.length > 0 && runningReindexJobs.value.length > 0) return 'Memory jobs active...'
        if (runningKnowledgeExtractionJobs.value.length > 0) return 'Knowledge extraction active...'
        if (runningReindexJobs.value.length > 0) return 'Memory indexing active...'
        return ''
    })

    async function refresh(): Promise<void> {
        if (refreshing.value) return
        refreshing.value = true
        try {
            jobs.value = await api.memorySpaces.listAllJobs()
            loaded.value = true
        } catch {
            jobs.value = []
        } finally {
            refreshing.value = false
        }
    }

    function upsertJob(job: MemoryIndexJob): void {
        jobs.value = [...jobs.value.filter(item => item.id !== job.id), job]
    }

    async function cancelJob(jobId: string): Promise<void> {
        try {
            upsertJob(await api.memorySpaces.cancelJob(jobId))
            await refresh()
        } catch {
            /* ignore */
        }
    }

    async function cancelRunningJobs(): Promise<void> {
        await Promise.all(activeJobs.value.map(job => cancelJob(job.id)))
        await refresh()
    }

    function startPolling(): void {
        if (pollTimer) return
        void refresh()
        pollTimer = setInterval(() => {
            void refresh()
        }, 3000)
    }

    function stopPolling(): void {
        if (!pollTimer) return
        clearInterval(pollTimer)
        pollTimer = null
    }

    return {
        jobs,
        loaded,
        refreshing,
        runningJobs,
        activeJobs,
        runningReindexJobs,
        runningKnowledgeExtractionJobs,
        hasRunningJobs,
        statusLabel,
        refresh,
        upsertJob,
        cancelJob,
        cancelRunningJobs,
        startPolling,
        stopPolling,
    }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useMemoryJobsStore, import.meta.hot))
}
