import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import {
    countConversationAttachmentChunks,
    indexConversationAttachment,
    listConversationFileAttachments,
} from '../../artifacts/attachment-rag.js'
import { getDb } from '../../../db/database.js'
import type { FileAttachmentArtifact } from '../../artifacts/file-artifacts.js'

export interface EnsureAttachmentIndexesInput {
    conversationId: string
    inlineAttachmentTextLimit: number
    eventMeta?: Record<string, unknown>
}

interface AttachmentIndexSummary {
    attachment: FileAttachmentArtifact
    status: 'already-indexed' | 'indexed' | 'not-indexed'
    chunkCount: number
}

export async function ensureOversizedAttachmentsIndexed(input: EnsureAttachmentIndexesInput): Promise<void> {
    const { conversationId, inlineAttachmentTextLimit, eventMeta } = input
    const oversized = listConversationFileAttachments(getDb(), conversationId)
        .filter((attachment) => attachment.textBytes > inlineAttachmentTextLimit)

    if (!oversized.length) return

    const taskId = `attachment_index_${nanoid()}`
    emitAttachmentIndexStatus(conversationId, taskId, eventMeta)

    const summaries: AttachmentIndexSummary[] = []
    for (const attachment of oversized) {
        let chunkCount = attachment.chunkCount || await countConversationAttachmentChunks(conversationId, attachment.id)
        let status: AttachmentIndexSummary['status'] = chunkCount > 0 ? 'already-indexed' : 'not-indexed'

        if (chunkCount <= 0) {
            chunkCount = await indexConversationAttachment(conversationId, attachment)
            status = chunkCount > 0 ? 'indexed' : 'not-indexed'
        }

        attachment.chunkCount = chunkCount || undefined
        summaries.push({ attachment, status, chunkCount })
    }

    emitAttachmentIndexSelection(conversationId, taskId, summaries, eventMeta)
    emitAttachmentIndexResults(conversationId, taskId, summaries, eventMeta)
}

function emitAttachmentIndexStatus(
    conversationId: string,
    taskId: string,
    eventMeta?: Record<string, unknown>,
): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status: 'indexing-attachments',
        message: 'Indexing attachments...',
        ...eventMeta,
    })
}

function emitAttachmentIndexSelection(
    conversationId: string,
    taskId: string,
    summaries: AttachmentIndexSummary[],
    eventMeta?: Record<string, unknown>,
): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: summaries.map(({ attachment, status, chunkCount }) => ({
            name: attachment.name,
            arguments: JSON.stringify({
                type: 'attachment-index',
                attachmentId: attachment.id,
                status,
                textBytes: attachment.textBytes,
                chunkCount,
            }),
        })),
    })
}

function emitAttachmentIndexResults(
    conversationId: string,
    taskId: string,
    summaries: AttachmentIndexSummary[],
    eventMeta?: Record<string, unknown>,
): void {
    getEventBus().emit('step:executed', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        results: summaries.map(({ attachment, status, chunkCount }) => ({
            name: attachment.name,
            success: chunkCount > 0,
            output: chunkCount > 0
                ? `${status === 'already-indexed' ? 'Already indexed' : 'Indexed'} ${attachment.name} into ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}.`
                : `No indexable text chunks were produced for ${attachment.name}.`,
        })),
    })
}
