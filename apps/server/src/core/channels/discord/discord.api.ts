import type { Message, MessageCreateOptions } from 'discord.js'

export type DiscordSendChannel = {
    send: (payload: string | MessageCreateOptions) => Promise<Message>
}

export async function sendLongMessage(channel: DiscordSendChannel, text: string): Promise<void> {
    const MAX_LEN = 1900
    if (text.length <= MAX_LEN) {
        await channel.send(text).catch(() => { })
        return
    }

    let remaining = text
    while (remaining.length > 0) {
        if (remaining.length <= MAX_LEN) {
            await channel.send(remaining).catch(() => { })
            break
        }
        let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN)
        if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('\n', MAX_LEN)
        if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN
        await channel.send(remaining.slice(0, splitAt)).catch(() => { })
        remaining = remaining.slice(splitAt).trimStart()
    }
}

export function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; ext: string } {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!match) return { buffer: Buffer.alloc(0), ext: 'png' }
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
    return { buffer: Buffer.from(match[2], 'base64'), ext }
}

export async function extractAttachments(msg: Message): Promise<{ imageDataUrls: string[]; audioDataUrls: string[] }> {
    const imageDataUrls: string[] = []
    const audioDataUrls: string[] = []

    for (const [, attachment] of msg.attachments) {
        const mime = attachment.contentType || ''
        try {
            const res = await fetch(attachment.url)
            if (!res.ok) continue
            const buffer = Buffer.from(await res.arrayBuffer())
            const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
            if (mime.startsWith('image/')) {
                imageDataUrls.push(dataUrl)
            } else if (mime.startsWith('audio/')) {
                audioDataUrls.push(dataUrl)
            }
        } catch {
            continue
        }
    }

    return { imageDataUrls, audioDataUrls }
}
