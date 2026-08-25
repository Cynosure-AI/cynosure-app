let activeController: AbortController | null = null

export function beginMemoryReembedding(): AbortController | null {
    if (activeController && !activeController.signal.aborted) return null
    activeController = new AbortController()
    return activeController
}

export function finishMemoryReembedding(controller: AbortController): void {
    if (activeController === controller) activeController = null
}

export function cancelActiveMemoryReembedding(): boolean {
    if (!activeController || activeController.signal.aborted) return false
    activeController.abort()
    return true
}
