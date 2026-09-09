export const ATTACHMENT_TOOL_NAMES = [
    'attachment_search',
    'attachment_read',
] as const

export function isAttachmentToolName(toolName: string): boolean {
    return (ATTACHMENT_TOOL_NAMES as readonly string[]).includes(toolName)
}
