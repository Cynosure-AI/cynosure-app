import type { TelegramCtx, TelegramUpdate } from './telegram.types.js'
import { downloadTelegramFile } from './telegram.api.js'

/** Extract image and audio attachments from a Telegram message, downloading them as data URLs. */
export async function extractAttachments(ctx: TelegramCtx, msg: NonNullable<TelegramUpdate['message']>): Promise<{ imageDataUrls: string[]; audioDataUrls: string[] }> {
    const imageDataUrls: string[] = []
    const audioDataUrls: string[] = []

    // Photos — Telegram sends multiple sizes, pick the largest
    if (msg.photo?.length) {
        const largest = msg.photo[msg.photo.length - 1]
        const { dataUrl } = await downloadTelegramFile(ctx, largest.file_id)
        imageDataUrls.push(dataUrl)
    }

    // Documents — treat images as image attachments
    if (msg.document) {
        const mime = msg.document.mime_type || ''
        if (mime.startsWith('image/')) {
            const { dataUrl } = await downloadTelegramFile(ctx, msg.document.file_id)
            imageDataUrls.push(dataUrl)
        }
    }

    // Audio / voice messages
    if (msg.audio) {
        const { dataUrl } = await downloadTelegramFile(ctx, msg.audio.file_id)
        audioDataUrls.push(dataUrl)
    }
    if (msg.voice) {
        const { dataUrl } = await downloadTelegramFile(ctx, msg.voice.file_id)
        audioDataUrls.push(dataUrl)
    }

    return { imageDataUrls, audioDataUrls }
}
