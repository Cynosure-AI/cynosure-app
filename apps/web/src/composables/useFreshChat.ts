import { readonly, ref } from 'vue'

// ── Fresh chat state ──────────────────────────────────────────────────────────
// The chat view reports while it shows a new, empty conversation so app-level
// decoration (the water field) can come forward only there.

const freshChat = ref(false)

export function useFreshChat() {
    function setFreshChat(value: boolean) {
        freshChat.value = value
    }
    return { freshChat: readonly(freshChat), setFreshChat }
}
