import type { WebSocket } from 'ws'

/** Per-client subscription state */
interface ClientState {
  ws: WebSocket
  alive: boolean
  conversationIds: Set<string>
  hasConversationSubscription: boolean
}

const clients = new Map<WebSocket, ClientState>()

// Events that are never tied to a single conversation and should always reach
// every connected client (system-wide progress/status, not chat content).
// IMPORTANT: this is the only list that should require manual upkeep. Any event
// whose payload carries a `conversationId` (directly or nested under `data`) is
// automatically scoped to clients subscribed to that conversation — see
// `canReceiveEvent` below. Do NOT add conversation-specific events here; doing
// so is exactly what caused past "sub-agent events leaking into other chats"
// regressions (an event forgotten from an allowlist silently broadcast globally).
const globalEventNames = new Set([
  'memory:job-updated',
  'memory:reembed-progress',
  'backup:restore-progress',
  'notification:created',
  'mcp-auth-needed',
  'mcp-auth-complete',
  // Carries only execution discovery metadata so clients can subscribe to a
  // remotely-created channel conversation before its scoped stream events.
  'channel:conversation-state',
])

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
  return !globalEventNames.has(event)
}

function canReceiveEvent(state: ClientState, event: string, data: unknown): boolean {
  if (!shouldScopeEvent(event)) return true

  const conversationId = getConversationId(data)
  // No conversationId found on an event that isn't explicitly global — this
  // most likely means it's genuinely conversation-scoped but the payload
  // shape wasn't recognized. Dropping it is safer than leaking it into
  // whatever conversation the client happens to be viewing.
  if (!conversationId) return false

  // Conversation-scoped events must not fall back to a global firehose. During
  // startup or reconnects, a cron/channel run can emit before the UI sends its
  // subscription; dropping that event is safer than leaking it into another chat.
  if (!state.hasConversationSubscription) return false
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
