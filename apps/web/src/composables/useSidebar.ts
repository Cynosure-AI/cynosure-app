import { ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { syncPrefsToElectron } from '@/utils/electron-prefs'
import { SK_SIDEBAR_COLLAPSED, SK_CHAT_SIDEBAR_OPEN } from '@/utils/storage-keys'

// ── App Sidebar (main navigation) ──────────────────────────────────────────────

const sidebarOpen = ref(false)
const sidebarCollapsed = useLocalStorage(SK_SIDEBAR_COLLAPSED, false)

export function useSidebar() {
    function toggle() {
        sidebarOpen.value = !sidebarOpen.value
    }
    function close() {
        sidebarOpen.value = false
    }
    function toggleCollapse() {
        sidebarCollapsed.value = !sidebarCollapsed.value
    }
    return { sidebarOpen, sidebarCollapsed, toggle, close, toggleCollapse }
}

// ── Chat Sidebar (conversation list) ───────────────────────────────────────────

function getChatSidebarInitial(): boolean {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(SK_CHAT_SIDEBAR_OPEN)
    if (stored !== null) return stored === 'true'
    return window.innerWidth >= 1024
}

const chatSidebarOpen = ref(getChatSidebarInitial())

export function useChatSidebar() {
    function toggle() {
        chatSidebarOpen.value = !chatSidebarOpen.value
        localStorage.setItem(SK_CHAT_SIDEBAR_OPEN, String(chatSidebarOpen.value))
        syncPrefsToElectron()
    }
    function close() {
        chatSidebarOpen.value = false
        localStorage.setItem(SK_CHAT_SIDEBAR_OPEN, 'false')
        syncPrefsToElectron()
    }
    return { chatSidebarOpen, toggle, close }
}
