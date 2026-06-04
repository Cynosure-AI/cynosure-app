/**
 * Centralised localStorage keys used across the app.
 * Import from here to avoid typos and make keys easy to discover.
 */

// ── UI preferences (synced to Electron JSON file) ──────────────────────────────
export const SK_THEME = 'cy-theme'
export const SK_AUTO_EXPAND = 'cy-auto-expand'
export const SK_AUTO_EXPAND_TOOLS = 'cy-auto-expand-tools'
export const SK_GENERATE_TITLE = 'cy-generate-title'
export const SK_TITLE_PROVIDER = 'cy-title-provider'
export const SK_TITLE_MODEL = 'cy-title-model'
export const SK_ENABLE_ENTITY_GRAPH = 'cy-enable-entity-graph'
export const SK_ENTITY_GRAPH_PROVIDER = 'cy-entity-graph-provider'
export const SK_ENTITY_GRAPH_MODEL = 'cy-entity-graph-model'
export const SK_TOOL_ROUTER_PROVIDER = 'cy-tool-router-provider'
export const SK_TOOL_ROUTER_MODEL = 'cy-tool-router-model'
export const SK_MEMORY_ROUTER_PROVIDER = 'cy-memory-router-provider'
export const SK_MEMORY_ROUTER_MODEL = 'cy-memory-router-model'
export const SK_CONTEXT_STRATEGY = 'cy-context-strategy'
export const SK_COMPACT_PROVIDER = 'cy-compact-provider'
export const SK_COMPACT_MODEL = 'cy-compact-model'
export const SK_PROVIDER_MODEL_FAVORITES = 'cy-provider-model-favorites'
export const SK_AGENT_CATEGORIES = 'cy-agent-categories'
export const SK_MA_CATEGORIES = 'cy-ma-categories'

// ── Whisper / STT ──────────────────────────────────────────────────────────────
export const SK_WHISPER_MODEL = 'cy-whisper-model'
export const SK_WHISPER_ENABLED = 'cy-whisper-enabled'
export const SK_WHISPER_QUANTIZATION = 'cy-whisper-quantization'
export const SK_WHISPER_LANGUAGE = 'cy-whisper-language'
export const SK_WHISPER_DOWNLOADED = 'cy-whisper-downloaded'
export const SK_WHISPER_MIC_DEVICE = 'cy-whisper-mic-device'

// ── Onboarding ─────────────────────────────────────────────────────────────────
export const SK_ONBOARDING_COMPLETE = 'cy-onboarding-complete'

// ── Layout state ───────────────────────────────────────────────────────────────
export const SK_SIDEBAR_COLLAPSED = 'sidebar-collapsed'
export const SK_CHAT_SIDEBAR_OPEN = 'chat-sidebar-open'
export const SK_ACTIVE_AGENT = 'cy-active-agent'
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
    SK_TITLE_PROVIDER,
    SK_TITLE_MODEL,
    SK_ENABLE_ENTITY_GRAPH,
    SK_ENTITY_GRAPH_PROVIDER,
    SK_ENTITY_GRAPH_MODEL,
    SK_TOOL_ROUTER_PROVIDER,
    SK_TOOL_ROUTER_MODEL,
    SK_MEMORY_ROUTER_PROVIDER,
    SK_MEMORY_ROUTER_MODEL,
    SK_COMPACT_PROVIDER,
    SK_COMPACT_MODEL,
    SK_PROVIDER_MODEL_FAVORITES,
    SK_AGENT_CATEGORIES,
    SK_MA_CATEGORIES,
    SK_WHISPER_MODEL,
    SK_WHISPER_ENABLED,
    SK_WHISPER_QUANTIZATION,
    SK_WHISPER_LANGUAGE,
    SK_CHAT_SIDEBAR_OPEN,
    SK_WHISPER_MIC_DEVICE,
] as const
