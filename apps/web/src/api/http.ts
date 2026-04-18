import { ref } from 'vue'

export const BASE_URL = import.meta.env.VITE_API_URL || ''

// ── HTTP helpers ────────────────────────────────────────────────────────────

export async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`)
    if (!res.ok) throw new Error(`GET ${path}: ${res.statusText}`)
    return res.json() as Promise<T>
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
    const opts: RequestInit = { method: 'POST' }
    if (body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json' }
        opts.body = JSON.stringify(body)
    }
    const res = await fetch(`${BASE_URL}${path}`, opts)
    if (!res.ok) {
        let msg = `POST ${path}: ${res.statusText}`
        try { const err = await res.json(); if (err?.error) msg = err.error } catch { /* ignore */ }
        throw new Error(msg)
    }
    return res.json() as Promise<T>
}

export async function put<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!res.ok) throw new Error(`PUT ${path}: ${res.statusText}`)
    return res.json() as Promise<T>
}

export async function patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!res.ok) throw new Error(`PATCH ${path}: ${res.statusText}`)
    return res.json() as Promise<T>
}

export async function del<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`DELETE ${path}: ${res.statusText}`)
    return res.json() as Promise<T>
}

// ── WebSocket singleton ─────────────────────────────────────────────────────

export const wsConnected = ref(false)

export type WsHandler = (data: unknown) => void
const wsListeners = new Map<string, Set<WsHandler>>()
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

function getWsUrl(): string {
    if (BASE_URL) {
        const url = new URL(BASE_URL)
        const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        return `${protocol}//${url.host}/ws`
    }
    // In Electron with app:// protocol, connect to the embedded server directly
    const electronApi = (window as any).electron
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
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event, data }))
    }
}
