import { ref } from 'vue'

export const BASE_URL = import.meta.env.VITE_API_URL || ''

interface ElectronBridge {
    serverPort?: number
}

interface WindowWithElectron extends Window {
    electron?: ElectronBridge
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function readJson<T>(res: Response): Promise<T> {
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
}

function errorMessage(method: string, path: string, res: Response, payload: unknown): string {
    if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
        return payload.error
    }
    if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
        return payload.message
    }
    return `${method} ${path}: ${res.statusText || res.status}`
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const opts: RequestInit = { method, signal }
    if (body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json' }
        opts.body = JSON.stringify(body)
    }

    const res = await fetch(`${BASE_URL}${path}`, opts)
    if (!res.ok) {
        let payload: unknown
        try {
            payload = await readJson<unknown>(res)
        } catch {
            payload = undefined
        }
        throw new Error(errorMessage(method, path, res, payload))
    }

    return readJson<T>(res)
}

export function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return request<T>('GET', path, undefined, signal)
}

export function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return request<T>('POST', path, body, signal)
}

export function put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PUT', path, body)
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PATCH', path, body)
}

export function del<T>(path: string): Promise<T> {
    return request<T>('DELETE', path)
}

// ── WebSocket singleton ─────────────────────────────────────────────────────

export const wsConnected = ref(false)

export type WsHandler = (data: unknown) => void
const wsListeners = new Map<string, Set<WsHandler>>()
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
const pendingWsMessages: string[] = []
let currentConversationSubscriptions: string[] = []
let hasConversationSubscription = false

function getWsUrl(): string {
    if (BASE_URL) {
        const url = new URL(BASE_URL)
        const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        return `${protocol}//${url.host}/ws`
    }
    // In Electron with app:// protocol, connect to the embedded server directly
    const electronApi = (window as WindowWithElectron).electron
    if (electronApi?.serverPort) {
        return `ws://127.0.0.1:${electronApi.serverPort}/ws`
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${location.host}/ws`
}

function connectWs(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

    ws = new WebSocket(getWsUrl())

    ws.onopen = () => {
        wsConnected.value = true
        const socket = ws
        if (!socket) return
        if (hasConversationSubscription) {
            socket.send(JSON.stringify({
                event: 'client:subscribe-conversations',
                data: { conversationIds: currentConversationSubscriptions }
            }))
        }
        while (pendingWsMessages.length > 0 && socket.readyState === WebSocket.OPEN) {
            socket.send(pendingWsMessages.shift()!)
        }
    }

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data) as { event: string; data: unknown }
            const handlers = wsListeners.get(msg.event)
            if (handlers) {
                for (const handler of handlers) {
                    handler(msg.data)
                }
            }
        } catch {
            // ignore malformed
        }
    }

    ws.onclose = () => {
        wsConnected.value = false
        if (!wsReconnectTimer) {
            wsReconnectTimer = setTimeout(() => {
                wsReconnectTimer = null
                connectWs()
            }, 2000)
        }
    }

    ws.onerror = () => {
        ws?.close()
    }
}

export function onWsEvent(event: string, handler: WsHandler): () => void {
    if (!wsListeners.has(event)) wsListeners.set(event, new Set())
    wsListeners.get(event)!.add(handler)
    connectWs()
    return () => {
        wsListeners.get(event)?.delete(handler)
    }
}

export function sendWsMessage(event: string, data: unknown): void {
    connectWs()
    const message = JSON.stringify({ event, data })
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(message)
        return
    }
    pendingWsMessages.push(message)
}

export function subscribeWsConversations(conversationIds: string[]): void {
    currentConversationSubscriptions = [...conversationIds]
    hasConversationSubscription = true
    sendWsMessage('client:subscribe-conversations', { conversationIds })
}
