import { ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { SK_SIDEBAR_COLLAPSED } from '@/utils/storage-keys'

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
