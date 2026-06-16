import type { WebSocket } from 'ws'

/** Per-client subscription state */
interface ClientState {
  ws: WebSocket
  alive: boolean
  conversationIds: Set<string>
  hasConversationSubscription: boolean
}

const clients = new Map<WebSocket, ClientState>()

const conversationScopedEventPrefixes = [
  'chat:stream',
  'chat:subagent-stream',
  'chat:compact',
  'chat:post-action',
  'agent:execution-update',
  'agent:hitl-',
  'orchestrator:state-updated',
]

export function addClient(ws: WebSocket): void {
  clients.set(ws, { ws, alive: true, conversationIds: new Set(), hasConversationSubscription: false })
  ws.on('pong', () => {
    const state = clients.get(ws)
    if (state) state.alive = true
  })
  ws.on('close', () => clients.delete(ws))
}

export function removeClient(ws: WebSocket): void {
  clients.delete(ws)
}

export function setClientConversationSubscriptions(ws: WebSocket, conversationIds: string[]): void {
  const state = clients.get(ws)
  if (!state) return
  state.conversationIds = new Set(conversationIds.filter((id) => typeof id === 'string' && id.length > 0))
  state.hasConversationSubscription = true
}

function getConversationId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const direct = record.conversationId
  if (typeof direct === 'string') return direct

  const nested = record.data
  if (!nested || typeof nested !== 'object') return undefined
  const nestedConversationId = (nested as Record<string, unknown>).conversationId
  return typeof nestedConversationId === 'string' ? nestedConversationId : undefined
}

function shouldScopeEvent(event: string): boolean {
  return conversationScopedEventPrefixes.some((prefix) => event.startsWith(prefix))
}

function canReceiveEvent(state: ClientState, event: string, data: unknown): boolean {
  if (!shouldScopeEvent(event)) return true

  const conversationId = getConversationId(data)
  if (!conversationId) return true

  // Clients that have not sent a subscription yet keep legacy firehose behavior.
  if (!state.hasConversationSubscription) return true

  return state.conversationIds.has(conversationId)
}

/** Broadcast a typed event to connected clients, scoped by conversation when possible. */
export function broadcast(event: string, data: unknown): void {
  const msg = JSON.stringify({ event, data })
  for (const [ws, state] of clients) {
    if (!canReceiveEvent(state, event, data)) continue
    if (ws.readyState === ws.OPEN) {
      ws.send(msg)
    }
  }
}

/**
 * WebSocket keep-alive heartbeat — NOT the old agent-execution heartbeat scheduler.
 * Pings every connected client at the given interval; terminates any that
 * didn't respond with a pong since the last check (stale connections).
 * Call once on startup.
 */
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
