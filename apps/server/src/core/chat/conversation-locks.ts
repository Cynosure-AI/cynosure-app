const conversationLocks = new Map<string, Promise<unknown>>()

/**
 * Serialize /send handling per conversation so concurrent sends don't build
 * context from stale history or race while writing messages.
 */
export function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = conversationLocks.get(conversationId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    conversationLocks.set(conversationId, next)
    next.finally(() => {
        if (conversationLocks.get(conversationId) === next) {
            conversationLocks.delete(conversationId)
        }
    })
    return next
}
