import { TELEGRAM_API, type TelegramCtx, type TelegramUpdate } from './telegram.types.js'

export async function sendMessage(ctx: TelegramCtx, chatId: number, text: string): Promise<void> {
    await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    })
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

export async function sendMessageReturningId(ctx: TelegramCtx, chatId: number, text: string): Promise<number | null> {
    try {
        const res = await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
        })
        const data = await res.json() as { ok: boolean; result?: { message_id: number } }
        return data.ok ? data.result?.message_id ?? null : null
    } catch {
        return null
    }
}

export async function sendReply(ctx: TelegramCtx, chatId: number, replyToMsgId: number, text: string): Promise<void> {
    await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            reply_to_message_id: replyToMsgId,
            parse_mode: 'Markdown'
        })
    }).catch(() => { })
}

export async function editMessage(ctx: TelegramCtx, chatId: number, messageId: number, text: string): Promise<boolean> {
    try {
        const res = await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: 'Markdown'
            })
        })
        const data = await res.json() as { ok: boolean }
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
