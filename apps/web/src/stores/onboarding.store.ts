import { defineStore, acceptHMRUpdate } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { SK_ONBOARDING_COMPLETE } from '@/utils/storage-keys'

export const useOnboardingStore = defineStore('onboarding', () => {
    const completed = useLocalStorage(SK_ONBOARDING_COMPLETE, false)

    function finish() {
        completed.value = true
    }

    function reset() {
        completed.value = false
    }

    return { completed, finish, reset }
})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useOnboardingStore, import.meta.hot))
}
