export const SESSION_CONTENT_TOOL_NAMES = ['session_content_grep', 'session_content_read'] as const

export function isSessionContentToolName(toolName: string): boolean {
    return (SESSION_CONTENT_TOOL_NAMES as readonly string[]).includes(toolName)
}
