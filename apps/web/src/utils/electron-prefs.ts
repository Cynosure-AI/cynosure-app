/**
 * Bridges Electron's reliable filesystem storage with browser localStorage.
 *
 * Root cause of the issue this solves:
 * Chromium's LevelDB (which backs localStorage in Electron) uses a "Reuse old log"
 * optimization. Across multiple Electron restarts this causes the same log file to be
 * reused with overlapping LevelDB sequence numbers. On the next startup Chromium resolves
 * conflicts by sequence number rather than file position, so an earlier session's write
 * (with a higher seq#) can silently win over the latest session's write (lower seq#).
 * The practical effect: theme / sidebar state looks "reset" after every restart.
 *
 * Fix: after writing a preference to localStorage we also push a snapshot of all pref
 * keys to a plain JSON file via IPC. On each cold start main.ts reseeds localStorage
 * from that file before Vue/Pinia initialise so stores always see the correct values.
 */

import { ELECTRON_SYNCED_KEYS } from './storage-keys'

type ElectronApi = {
    getUiPrefs: () => Record<string, string>
    setUiPrefs: (prefs: Record<string, string>) => void
}

function getElectronApi(): ElectronApi | null {
    const el = (window as unknown as Record<string, unknown>).electron as ElectronApi | undefined
    if (typeof el?.getUiPrefs === 'function' && typeof el?.setUiPrefs === 'function') return el
    return null
}

/** Snapshot all known pref keys from localStorage and push to the Electron JSON file. */
export function syncPrefsToElectron(): void {
    const el = getElectronApi()
    if (!el) return

    const prefs: Record<string, string> = {}
    for (const key of ELECTRON_SYNCED_KEYS) {
        const v = localStorage.getItem(key)
        if (v !== null) prefs[key] = v
    }
    el.setUiPrefs(prefs)
}

/** On Electron cold-start: seed localStorage from the reliable JSON file BEFORE Vue boots. */
export function restorePrefsFromElectron(): void {
    const el = getElectronApi()
    if (!el) return

    const saved = el.getUiPrefs()
    for (const [key, value] of Object.entries(saved)) {
        localStorage.setItem(key, value)
    }
}
