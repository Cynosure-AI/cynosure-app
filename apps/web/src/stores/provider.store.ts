import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../api/client'
import type { LLMProviderConfig, ModelListItem, ModelListType } from '../api/types'

export type { LLMProviderConfig }

export const useProviderStore = defineStore('provider', () => {
  const providers = ref<LLMProviderConfig[]>([])
  const lastUsedProviderId = ref<string>('')
  const connectionStatus = ref<Map<string, 'connected' | 'disconnected' | 'error'>>(new Map())

  const lastUsedProvider = computed(() =>
    providers.value.find((p) => p.id === lastUsedProviderId.value)
  )

  async function loadProviders(): Promise<void> {
    await api.provider.loadSaved()
    providers.value = await api.provider.list()
    lastUsedProviderId.value = await api.provider.getLastUsed()
  }

  async function addProvider(config: LLMProviderConfig): Promise<string> {
    const id = await api.provider.add(config)
    providers.value = await api.provider.list()
    if (!lastUsedProviderId.value) {
      lastUsedProviderId.value = id
    }
    return id
  }

  async function removeProvider(id: string): Promise<void> {
    await api.provider.remove(id)
    providers.value = await api.provider.list()
    if (lastUsedProviderId.value === id) {
      lastUsedProviderId.value = providers.value[0]?.id || ''
    }
  }

  async function setLastUsed(id: string): Promise<void> {
    await api.provider.setLastUsed(id)
    lastUsedProviderId.value = id
  }

  async function testConnection(id: string): Promise<boolean> {
    const result = await api.provider.test(id)
    connectionStatus.value.set(id, result ? 'connected' : 'error')
    return result
  }

  async function listModels(id: string, type?: ModelListType): Promise<string[]> {
    return api.provider.listModels(id, type)
  }

  async function listModelItems(id: string, type?: ModelListType): Promise<ModelListItem[]> {
    return api.provider.listModelItems(id, type)
  }

  return {
    providers,
    lastUsedProviderId,
    connectionStatus,
    lastUsedProvider,
    loadProviders,
    addProvider,
    removeProvider,
    setLastUsed,
    testConnection,
    listModels,
    listModelItems
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProviderStore, import.meta.hot))
}
