import { ref } from 'vue'

// ── Global search / quick picker (Ctrl+K) ──────────────────────────────────────

const commandPaletteOpen = ref(false)

const isApplePlatform = typeof navigator !== 'undefined'
    && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Human-readable shortcut for hints in the UI. */
export const commandPaletteShortcutLabel = isApplePlatform ? '⌘K' : 'Ctrl K'

/** True for the platform shortcut that toggles the palette: Ctrl+K, or Cmd+K on macOS. */
export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === 'k'
        && (event.ctrlKey || event.metaKey)
        && !event.altKey
        && !event.shiftKey
}

export function useCommandPalette() {
    function open() {
        commandPaletteOpen.value = true
    }
    function close() {
        commandPaletteOpen.value = false
    }
    function toggle() {
        commandPaletteOpen.value = !commandPaletteOpen.value
    }
    return { commandPaletteOpen, open, close, toggle }
}
