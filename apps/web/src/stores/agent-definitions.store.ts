import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref } from 'vue'
import { api, type AgentDefinition } from '../api/client'

export type { AgentDefinition }

export const useAgentDefinitionsStore = defineStore('agent-definitions', () => {
    const agents = ref<AgentDefinition[]>([])

    async function load() {
        agents.value = await api.agents.list()
    }

    async function create(
        data: Partial<Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>>
    ): Promise<AgentDefinition> {
        const agent = await api.agents.create(data)
        agents.value.push(agent)
        return agent
    }

    async function update(id: string, data: Partial<Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>>) {
        const updated = await api.agents.update(id, data)
        const idx = agents.value.findIndex((a) => a.id === id)
        if (idx !== -1) {
            agents.value[idx] = updated
        }
    }

    async function remove(id: string) {
        await api.agents.remove(id)
        agents.value = agents.value.filter((a) => a.id !== id)
    }

    async function duplicate(id: string): Promise<AgentDefinition> {
        const copy = await api.agents.duplicate(id)
        agents.value.unshift(copy)
        return copy
    }

    function get(id: string) {
        return agents.value.find((a) => a.id === id)
    }

    return { agents, load, create, update, remove, duplicate, get }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useAgentDefinitionsStore, import.meta.hot))
}
