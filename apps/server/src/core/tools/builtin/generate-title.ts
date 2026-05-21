import { getDb } from '../../../db/database.js'
import type { ToolDefinition } from '../../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface GenerateTitleToolOptions {
    conversationId: string
    broadcast: BroadcastFn
}

/**
 * Create a `generate_title` tool the LLM calls with a short title.
 * Used as a structured-output mechanism for conversation title generation —
 * the LLM receives the conversation snippets and must call this tool with
 * the generated title, which is more token-efficient than free-form output.
 */
export function makeGenerateTitleTool(opts: GenerateTitleToolOptions): ToolDefinition {
    const { conversationId, broadcast } = opts
    return {
        name: 'generate_title',
        description: 'Set the conversation title. You MUST call this tool with a concise title.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short chat title (3-6 words) summarizing the request. No quotes, no punctuation at the end.' }
            },
            required: ['title']
        },
        timeout: 5_000,
        execute: async (params: unknown) => {
            const { title: rawTitle } = params as { title: string }
            const db = getDb()

            let title = rawTitle
                .replace(/^["'""''`]+|["'""''`]+$/g, '')
                .replace(/^Title:\s*/i, '')
                .replace(/[.!?:;,]+$/, '')
                .replace(/\s{2,}/g, ' ')
                .trim()
                .slice(0, 80)

            if (!title || title.split(/\s+/).length > 10 || /^(the user|this conversation|i |okay|let me)/i.test(title)) {
                return { success: false, output: 'Title rejected — too long or looks like reasoning.' }
            }

            db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), conversationId)
            broadcast('chat:title-updated', { conversationId, title })
            return { success: true, output: title }
        }
    }
}
