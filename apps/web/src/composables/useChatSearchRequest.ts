import { ref } from 'vue'

/** Open a chat's search at a specific message, e.g. from a global search hit. */
export interface ChatSearchRequest {
    /** Distinguishes repeated requests for the same message. */
    id: number
    conversationId: string
    messageId: string
    query: string
}

const pendingChatSearch = ref<ChatSearchRequest | null>(null)
let nextRequestId = 0

export function useChatSearchRequest() {
    function requestChatSearch(conversationId: string, messageId: string, query: string): void {
        pendingChatSearch.value = { id: ++nextRequestId, conversationId, messageId, query }
    }
    function clearChatSearchRequest(): void {
        pendingChatSearch.value = null
    }
    return { pendingChatSearch, requestChatSearch, clearChatSearchRequest }
}
