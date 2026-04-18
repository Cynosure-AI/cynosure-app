/**
 * Centralised localStorage keys used across the app.
 * Import from here to avoid typos and make keys easy to discover.
 */

// ── UI preferences (synced to Electron JSON file) ──────────────────────────────
export const SK_THEME = 'oa-theme'
export const SK_AUTO_EXPAND = 'oa-auto-expand'
export const SK_AUTO_EXPAND_TOOLS = 'oa-auto-expand-tools'
export const SK_GENERATE_TITLE = 'oa-generate-title'
export const SK_CONTEXT_STRATEGY = 'oa-context-strategy'
export const SK_AGENT_CATEGORIES = 'oa-agent-categories'
export const SK_MA_CATEGORIES = 'oa-ma-categories'

// ── Whisper / STT ──────────────────────────────────────────────────────────────
export const SK_WHISPER_MODEL = 'oa-whisper-model'
export const SK_WHISPER_ENABLED = 'oa-whisper-enabled'
export const SK_WHISPER_QUANTIZATION = 'oa-whisper-quantization'
export const SK_WHISPER_LANGUAGE = 'oa-whisper-language'
export const SK_WHISPER_DOWNLOADED = 'oa-whisper-downloaded'

// ── Layout state ───────────────────────────────────────────────────────────────
export const SK_SIDEBAR_COLLAPSED = 'sidebar-collapsed'
export const SK_CHAT_SIDEBAR_OPEN = 'chat-sidebar-open'
export const SK_ACTIVE_AGENT = 'oa-active-agent'
export const SK_AGENTS_VIEW_MODE = 'agents-view-mode'

/**
 * All preference keys that should be synced to Electron's reliable JSON store.
 * Keep in sync when adding new keys above.
 */
export const ELECTRON_SYNCED_KEYS = [
    SK_THEME,
    SK_AUTO_EXPAND,
    SK_AUTO_EXPAND_TOOLS,
    SK_GENERATE_TITLE,
    SK_AGENT_CATEGORIES,
    SK_MA_CATEGORIES,
    SK_WHISPER_MODEL,
    SK_WHISPER_ENABLED,
    SK_WHISPER_QUANTIZATION,
    SK_WHISPER_LANGUAGE,
    SK_CHAT_SIDEBAR_OPEN,
] as const
