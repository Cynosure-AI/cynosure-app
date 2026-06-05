import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref } from 'vue'
import { api } from '../api/client'
import type { SkillDefinition } from '../api/types'

export const useSkillDefinitionsStore = defineStore('skill-definitions', () => {
  const skills = ref<SkillDefinition[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const loadError = ref('')
  let pendingLoad: Promise<void> | null = null

  async function load(options: { force?: boolean } = {}): Promise<void> {
    if (pendingLoad) return pendingLoad
    if (loaded.value && !options.force) return

    loading.value = true
    loadError.value = ''
    pendingLoad = api.skills.list()
      .then((items) => {
        skills.value = items
        loaded.value = true
      })
      .catch((err) => {
        loaded.value = false
        loadError.value = (err as Error).message
        throw err
      })
      .finally(() => {
        loading.value = false
        pendingLoad = null
      })

    return pendingLoad
  }

  function get(id: string): SkillDefinition | undefined {
    return skills.value.find((skill) => skill.id === id)
  }

  async function create(data: Partial<Omit<SkillDefinition, 'id' | 'createdAt' | 'updatedAt'>>): Promise<SkillDefinition> {
    const skill = await api.skills.create(data)
    skills.value.push(skill)
    skills.value.sort((a, b) => `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`))
    return skill
  }

  async function update(id: string, data: Partial<Omit<SkillDefinition, 'id' | 'createdAt' | 'updatedAt'>>): Promise<SkillDefinition> {
    const skill = await api.skills.update(id, data)
    const index = skills.value.findIndex((item) => item.id === id)
    if (index >= 0) skills.value[index] = skill
    return skill
  }

  async function remove(id: string): Promise<void> {
    await api.skills.remove(id)
    skills.value = skills.value.filter((skill) => skill.id !== id)
  }

  return { skills, loaded, loading, loadError, load, get, create, update, remove }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSkillDefinitionsStore, import.meta.hot))
}
