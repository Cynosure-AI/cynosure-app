import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref } from 'vue'
import { api } from '../api/client'
import type { SkillDefinition } from '../api/types'

export const useSkillDefinitionsStore = defineStore('skill-definitions', () => {
  const skills = ref<SkillDefinition[]>([])
  const loaded = ref(false)

  async function load(): Promise<void> {
    skills.value = await api.skills.list()
    loaded.value = true
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

  return { skills, loaded, load, get, create, update, remove }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSkillDefinitionsStore, import.meta.hot))
}
