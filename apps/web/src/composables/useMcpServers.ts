import { ref } from 'vue'
import { api, type McpServerInfo } from '../api/client'
import { useAgentStore } from '../stores/agent.store'

// Module-level refs so state is shared between all tab components
const servers = ref<McpServerInfo[]>([])
const loadingIds = ref<Set<string>>(new Set())
const actionError = ref<Record<string, string>>({})
const authInProgress = ref<string | null>(null)

export function useMcpServers() {
    const agentStore = useAgentStore()

    function isLoading(id: string): boolean {
        return loadingIds.value.has(id)
    }

    function setLoading(id: string, state: boolean): void {
        if (state) {
            loadingIds.value = new Set([...loadingIds.value, id])
        } else {
            const s = new Set(loadingIds.value)
            s.delete(id)
            loadingIds.value = s
        }
    }

    async function loadServers(): Promise<void> {
        servers.value = await api.mcp.listServers()
    }

    async function refreshAll(): Promise<void> {
        await loadServers()
        await agentStore.loadTools()
    }

    return {
        servers,
        loadingIds,
        actionError,
        authInProgress,
        isLoading,
        setLoading,
        loadServers,
        refreshAll,
    }
}
