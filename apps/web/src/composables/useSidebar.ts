import { ref } from 'vue'

const sidebarOpen = ref(false)
const sidebarCollapsed = ref(localStorage.getItem('sidebar-collapsed') === 'true')

export function useSidebar() {
    function toggle() {
        sidebarOpen.value = !sidebarOpen.value
    }
    function close() {
        sidebarOpen.value = false
    }
    function toggleCollapse() {
        sidebarCollapsed.value = !sidebarCollapsed.value
        localStorage.setItem('sidebar-collapsed', String(sidebarCollapsed.value))
    }
    return { sidebarOpen, sidebarCollapsed, toggle, close, toggleCollapse }
}
