export const CONVERSATION_HISTORY_TOOL_NAMES = ['conversation_search', 'conversation_read'] as const

export function isConversationHistoryToolName(toolName: string): boolean {
    return (CONVERSATION_HISTORY_TOOL_NAMES as readonly string[]).includes(toolName)
}
