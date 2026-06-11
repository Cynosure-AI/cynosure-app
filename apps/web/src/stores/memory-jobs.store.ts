import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api/client'
import type { MemoryIndexJob } from '../api/types'

export const useMemoryJobsStore = defineStore('memory-jobs', () => {
    const jobs = ref<MemoryIndexJob[]>([])
    const loaded = ref(false)
    const refreshing = ref(false)
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const runningJobs = computed(() => jobs.value.filter(job => job.status === 'running'))
    const runningReindexJobs = computed(() => runningJobs.value.filter(job => job.kind === 'reindex'))
    const runningEntityJobs = computed(() => runningJobs.value.filter(job => job.kind === 'entity-index'))
    const hasRunningJobs = computed(() => runningJobs.value.length > 0)
    const statusLabel = computed(() => {
        if (runningEntityJobs.value.length > 0 && runningReindexJobs.value.length > 0) return 'Memory jobs running...'
        if (runningEntityJobs.value.length > 0) return 'Extracting entities...'
        if (runningReindexJobs.value.length > 0) return 'Indexing memories...'
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
        await Promise.all(runningJobs.value.map(job => cancelJob(job.id)))
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
        runningReindexJobs,
        runningEntityJobs,
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
