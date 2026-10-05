import type { TelegramCtx, TelegramUpdate } from './telegram.channel.js'
import { formatTelegramHtml } from './telegram.format.js'

export const TELEGRAM_API = 'https://api.telegram.org'

interface TelegramResponse<T = unknown> {
    ok: boolean
    description?: string
    result?: T
}

async function callTelegram<T>(ctx: TelegramCtx, method: string, body: Record<string, unknown>): Promise<TelegramResponse<T>> {
    const res = await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    const data = await res.json().catch(() => null) as TelegramResponse<T> | null
    return data ?? { ok: false, description: `Telegram API error: ${res.status} ${res.statusText}` }
}

/** Send Markdown as Telegram HTML; if Telegram rejects the markup (or it pushes the text past the length limit), resend the original text unformatted. */
async function callWithFormattedText<T>(ctx: TelegramCtx, method: string, body: Record<string, unknown>, text: string): Promise<TelegramResponse<T>> {
    const data = await callTelegram<T>(ctx, method, { ...body, text: formatTelegramHtml(text), parse_mode: 'HTML' })
    if (data.ok || !/can't parse entities|message is too long/i.test(data.description ?? '')) return data
    console.warn(`[Telegram] Formatting rejected, sending plain text: ${data.description}`)
    return callTelegram<T>(ctx, method, { ...body, text })
}

export async function sendMessage(ctx: TelegramCtx, chatId: number, text: string): Promise<void> {
    const data = await callWithFormattedText(ctx, 'sendMessage', { chat_id: chatId }, text)
    if (!data.ok) throw new Error(data.description || 'Telegram API error')
}

export async function sendLongMessage(ctx: TelegramCtx, chatId: number, text: string): Promise<void> {
    const MAX_LEN = 4000
    if (text.length <= MAX_LEN) {
        await sendMessage(ctx, chatId, text)
        return
    }
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
        if (remaining.length <= MAX_LEN) {
            chunks.push(remaining)
            break
        }
        let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN)
        if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('\n', MAX_LEN)
        if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN
        chunks.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt).trimStart()
    }
    for (const chunk of chunks) {
        await sendMessage(ctx, chatId, chunk)
    }
}

export async function sendMessageReturningId(
    ctx: TelegramCtx,
    chatId: number,
    text: string,
    extra: Record<string, unknown> = {}
): Promise<number | null> {
    try {
        const data = await callWithFormattedText<{ message_id: number }>(ctx, 'sendMessage', { ...extra, chat_id: chatId }, text)
        return data.ok ? data.result?.message_id ?? null : null
    } catch {
        return null
    }
}

export async function editMessage(ctx: TelegramCtx, chatId: number, messageId: number, text: string): Promise<boolean> {
    try {
        const data = await callWithFormattedText(ctx, 'editMessageText', { chat_id: chatId, message_id: messageId }, text)
        return data.ok
    } catch {
        return false
    }
}

export async function sendChatAction(ctx: TelegramCtx, chatId: number, action: string): Promise<void> {
    await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action })
    })
}

export async function answerCallbackQuery(ctx: TelegramCtx, callbackQueryId: string, text?: string): Promise<void> {
    await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    }).catch(() => { })
}

export async function sendPhoto(ctx: TelegramCtx, chatId: number, dataUrl: string, replyToMsgId?: number): Promise<void> {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!match) return
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
    const buffer = Buffer.from(match[2], 'base64')
    const boundary = '----OABoundary' + Date.now()
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`))
    if (replyToMsgId) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${replyToMsgId}\r\n`))
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="image.${ext}"\r\nContent-Type: image/${match[1]}\r\n\r\n`))
    parts.push(buffer)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body
    })
}

export async function downloadTelegramFile(ctx: TelegramCtx, fileId: string): Promise<{ dataUrl: string; mimeType: string }> {
    const fileRes = await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId })
    })
    const fileData = await fileRes.json() as { ok: boolean; result?: { file_path: string } }
    if (!fileData.ok || !fileData.result?.file_path) {
        throw new Error('Failed to get file path from Telegram')
    }
    const downloadUrl = `${TELEGRAM_API}/file/bot${ctx.botToken}/${fileData.result.file_path}`
    const downloadRes = await fetch(downloadUrl)
    if (!downloadRes.ok) throw new Error(`Failed to download file: ${downloadRes.status}`)
    const buffer = Buffer.from(await downloadRes.arrayBuffer())

    const ext = fileData.result.file_path.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
        mp4: 'video/mp4', webm: 'video/webm',
    }
    const mimeType = mimeMap[ext] || 'application/octet-stream'
    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
    return { dataUrl, mimeType }
}

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
