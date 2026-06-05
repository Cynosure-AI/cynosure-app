export const ATTACHMENT_TOOL_NAMES = [
    'attachment_list_documents',
    'attachment_search',
    'attachment_retrieve_chunks',
] as const

export function isAttachmentToolName(toolName: string): boolean {
    return (ATTACHMENT_TOOL_NAMES as readonly string[]).includes(toolName)
}
