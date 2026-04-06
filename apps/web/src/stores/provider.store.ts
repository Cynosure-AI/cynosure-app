import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api, type LLMProviderConfig } from '../api/client'

export type { LLMProviderConfig }

export const useProviderStore = defineStore('provider', () => {
  const providers = ref<LLMProviderConfig[]>([])
  const activeProviderId = ref<string>('')
  const connectionStatus = ref<Map<string, 'connected' | 'disconnected' | 'error'>>(new Map())

  const activeProvider = computed(() =>
    providers.value.find((p) => p.id === activeProviderId.value)
  )

  async function loadProviders(): Promise<void> {
    await api.provider.loadSaved()
    providers.value = await api.provider.list()
    activeProviderId.value = await api.provider.getActive()
  }

  async function addProvider(config: LLMProviderConfig): Promise<string> {
    const id = await api.provider.add(config)
    providers.value = await api.provider.list()
    if (!activeProviderId.value) {
      activeProviderId.value = id
    }
    return id
  }

  async function removeProvider(id: string): Promise<void> {
    await api.provider.remove(id)
    providers.value = await api.provider.list()
    if (activeProviderId.value === id) {
      activeProviderId.value = providers.value[0]?.id || ''
    }
  }

  async function setActive(id: string): Promise<void> {
    await api.provider.setActive(id)
    activeProviderId.value = id
  }

  async function testConnection(id: string): Promise<boolean> {
    const result = await api.provider.test(id)
    connectionStatus.value.set(id, result ? 'connected' : 'error')
    return result
  }

  async function listModels(id: string, type?: 'llm' | 'embedding'): Promise<string[]> {
    return api.provider.listModels(id, type)
  }

  return {
    providers,
    activeProviderId,
    connectionStatus,
    activeProvider,
    loadProviders,
    addProvider,
    removeProvider,
    setActive,
    testConnection,
    listModels
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProviderStore, import.meta.hot))
}
