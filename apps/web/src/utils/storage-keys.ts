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
export const SK_ENTITY_GRAPH_PROVIDER = 'cy-entity-graph-provider'
export const SK_ENTITY_GRAPH_MODEL = 'cy-entity-graph-model'
export const SK_AUTO_ROUTER_PROVIDER = 'cy-auto-router-provider'
export const SK_AUTO_ROUTER_MODEL = 'cy-auto-router-model'
export const SK_LEGACY_SKILL_ROUTER_PROVIDER = 'cy-skill-router-provider'
export const SK_LEGACY_SKILL_ROUTER_MODEL = 'cy-skill-router-model'
export const SK_CONTEXT_STRATEGY = 'cy-context-strategy'
export const SK_INLINE_ATTACHMENT_TEXT_LIMIT = 'cy-inline-attachment-text-limit'
export const SK_COMPACT_PROVIDER = 'cy-compact-provider'
export const SK_COMPACT_MODEL = 'cy-compact-model'
export const SK_PROVIDER_MODEL_FAVORITES = 'cy-provider-model-favorites'
export const SK_FREE_CHAT_PROVIDER = 'cy-free-chat-provider'
export const SK_FREE_CHAT_MODEL = 'cy-free-chat-model'
export const SK_AGENT_CATEGORIES = 'cy-agent-categories'
export const SK_MA_CATEGORIES = 'cy-ma-categories'
export const SK_MEMORY_GRAPH_NODE_SPACING = 'cy-memory-graph-node-spacing'
export const SK_MEMORY_GRAPH_EDGE_LABELS = 'cy-memory-graph-edge-labels'
export const SK_MEMORY_GRAPH_EDGE_PATH_TYPE = 'cy-memory-graph-edge-path-type'

// ── Whisper / STT ──────────────────────────────────────────────────────────────
export const SK_WHISPER_MODEL = 'cy-whisper-model'
export const SK_WHISPER_ENABLED = 'cy-whisper-enabled'
export const SK_WHISPER_QUANTIZATION = 'cy-whisper-quantization'
export const SK_WHISPER_LANGUAGE = 'cy-whisper-language'
export const SK_WHISPER_DOWNLOADED = 'cy-whisper-downloaded'
export const SK_WHISPER_MIC_DEVICE = 'cy-whisper-mic-device'
export const SK_VOICE_TRANSCRIPTION_MODE = 'cy-voice-transcription-mode'
export const SK_REMOTE_TRANSCRIPTION_PROVIDER = 'cy-remote-transcription-provider'
export const SK_REMOTE_TRANSCRIPTION_MODEL = 'cy-remote-transcription-model'

// ── Onboarding ─────────────────────────────────────────────────────────────────
export const SK_ONBOARDING_COMPLETE = 'cy-onboarding-complete'

// ── Layout state ───────────────────────────────────────────────────────────────
export const SK_SIDEBAR_COLLAPSED = 'sidebar-collapsed'
export const SK_CHAT_SIDEBAR_OPEN = 'chat-sidebar-open'
export const SK_ACTIVE_AGENT = 'cy-active-agent'
export const SK_AGENTS_VIEW_MODE = 'agents-view-mode'
export const SK_ACTIVITY_LOG_FILTERS = 'cy-activity-log-filters'

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
    SK_ENTITY_GRAPH_PROVIDER,
    SK_ENTITY_GRAPH_MODEL,
    SK_AUTO_ROUTER_PROVIDER,
    SK_AUTO_ROUTER_MODEL,
    SK_CONTEXT_STRATEGY,
    SK_INLINE_ATTACHMENT_TEXT_LIMIT,
    SK_COMPACT_PROVIDER,
    SK_COMPACT_MODEL,
    SK_PROVIDER_MODEL_FAVORITES,
    SK_FREE_CHAT_PROVIDER,
    SK_FREE_CHAT_MODEL,
    SK_AGENT_CATEGORIES,
    SK_MA_CATEGORIES,
    SK_MEMORY_GRAPH_NODE_SPACING,
    SK_MEMORY_GRAPH_EDGE_LABELS,
    SK_MEMORY_GRAPH_EDGE_PATH_TYPE,
    SK_WHISPER_MODEL,
    SK_WHISPER_ENABLED,
    SK_WHISPER_QUANTIZATION,
    SK_WHISPER_LANGUAGE,
    SK_CHAT_SIDEBAR_OPEN,
    SK_WHISPER_MIC_DEVICE,
    SK_VOICE_TRANSCRIPTION_MODE,
    SK_REMOTE_TRANSCRIPTION_PROVIDER,
    SK_REMOTE_TRANSCRIPTION_MODEL,
] as const
