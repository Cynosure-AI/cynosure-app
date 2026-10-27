import { readonly, ref, watch } from 'vue'
import { BASE_URL, wsConnected } from '../api/http'
import type { ServerStartupError } from '../api/types'
import type { ServerStartupProgress } from '@shared/types'

const POLL_INTERVAL_MS = 1000

const startupError = ref<ServerStartupError | null>(null)
const serverVersion = ref('')
const startupProgress = ref<ServerStartupProgress | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | null = null
let initialized = false

/**
 * Read /api/health directly: a server that failed to start answers 503 with a
 * structured `startupError`, which the regular `get` helper would discard.
 */
export async function checkServerHealth(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
    const body = await res.json() as {
      status?: string; version?: string; startupError?: ServerStartupError; startupProgress?: ServerStartupProgress
    }
    serverVersion.value = body.version ?? ''
    startupError.value = body.startupError ?? null
    startupProgress.value = body.status === 'starting' ? body.startupProgress ?? null : null
  } catch {
    // Server not reachable yet; the next poll tries again.
    startupProgress.value = null
  }
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function schedulePoll(): void {
  if (pollTimer || wsConnected.value || startupError.value) return
  pollTimer = setTimeout(async () => {
    pollTimer = null
    await checkServerHealth()
    schedulePoll()
  }, POLL_INTERVAL_MS)
}

/** Poll server health while the WebSocket is down, so a failed startup is surfaced instead of an endless reconnect. */
export function useServerStartupError() {
  if (!initialized) {
    initialized = true
    void checkServerHealth().then(schedulePoll)
    watch(wsConnected, (connected) => {
      if (connected) {
        stopPolling()
        startupError.value = null
        startupProgress.value = null
      } else {
        schedulePoll()
      }
    })
  }

  return {
    startupError: readonly(startupError), serverVersion: readonly(serverVersion),
    startupProgress: readonly(startupProgress),
  }
}
