import type { WebSocket } from 'ws'

/** Per-client subscription state */
interface ClientState {
  ws: WebSocket
  alive: boolean
}

const clients = new Map<WebSocket, ClientState>()

export function addClient(ws: WebSocket): void {
  clients.set(ws, { ws, alive: true })
  ws.on('pong', () => {
    const state = clients.get(ws)
    if (state) state.alive = true
  })
  ws.on('close', () => clients.delete(ws))
}

export function removeClient(ws: WebSocket): void {
  clients.delete(ws)
}

/** Broadcast a typed event to all connected clients */
export function broadcast(event: string, data: unknown): void {
  const msg = JSON.stringify({ event, data })
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg)
    }
  }
}

/** Heartbeat interval — call once on startup */
export function startHeartbeat(intervalMs = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate()
        clients.delete(ws)
        continue
      }
      state.alive = false
      ws.ping()
    }
  }, intervalMs)
}
