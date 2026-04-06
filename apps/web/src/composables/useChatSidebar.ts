import { ref } from 'vue'
import { syncPrefsToElectron } from '@/utils/electron-prefs'

const STORAGE_KEY = 'chat-sidebar-open'

function getInitialState(): boolean {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) return stored === 'true'
    return window.innerWidth >= 1024
}

const chatSidebarOpen = ref(getInitialState())

export function useChatSidebar() {
    function toggle() {
        chatSidebarOpen.value = !chatSidebarOpen.value
        localStorage.setItem(STORAGE_KEY, String(chatSidebarOpen.value))
        syncPrefsToElectron()
    }
    function close() {
        chatSidebarOpen.value = false
        localStorage.setItem(STORAGE_KEY, 'false')
        syncPrefsToElectron()
    }
    return { chatSidebarOpen, toggle, close }
}
