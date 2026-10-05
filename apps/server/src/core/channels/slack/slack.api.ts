import type { WebClient } from '@slack/web-api'
import type { SlackCtx } from './slack.channel.js'

export async function sendLongSlackMessage(
    client: WebClient,
    channel: string,
    text: string,
    threadTs?: string
): Promise<void> {
    const MAX_LEN = 3000
    if (text.length <= MAX_LEN) {
        await client.chat.postMessage({ channel, text, thread_ts: threadTs }).catch(() => { })
        return
    }

    let remaining = text
    while (remaining.length > 0) {
        if (remaining.length <= MAX_LEN) {
            await client.chat.postMessage({ channel, text: remaining, thread_ts: threadTs }).catch(() => { })
            break
        }
        let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN)
        if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('\n', MAX_LEN)
        if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN
        await client.chat.postMessage({ channel, text: remaining.slice(0, splitAt), thread_ts: threadTs }).catch(() => { })
        remaining = remaining.slice(splitAt).trimStart()
    }
}

export async function uploadImage(
    client: WebClient,
    channel: string,
    dataUrl: string,
    title: string,
    threadTs?: string
): Promise<void> {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!match) return
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
    const buffer = Buffer.from(match[2], 'base64')
    const uploadArgs: Record<string, unknown> = {
        channel_id: channel,
        file: buffer,
        filename: `${title}.${ext}`,
        title
    }
    if (threadTs) uploadArgs.thread_ts = threadTs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.filesUploadV2(uploadArgs as any)
}

export async function extractAttachments(
    ctx: SlackCtx,
    files: { id: string; name?: string; mimetype?: string; url_private_download?: string; url_private?: string }[]
): Promise<{ imageDataUrls: string[]; audioDataUrls: string[] }> {
    const imageDataUrls: string[] = []
    const audioDataUrls: string[] = []

    for (const file of files) {
        const downloadUrl = file.url_private_download || file.url_private
        if (!downloadUrl) continue

        const mime = file.mimetype || ''
        if (!mime.startsWith('image/') && !mime.startsWith('audio/')) continue

        try {
            const res = await fetch(downloadUrl, {
                headers: { Authorization: `Bearer ${ctx.botToken}` }
            })
            if (!res.ok) continue
            const buffer = Buffer.from(await res.arrayBuffer())
            const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`

            if (mime.startsWith('image/')) {
                imageDataUrls.push(dataUrl)
            } else if (mime.startsWith('audio/')) {
                audioDataUrls.push(dataUrl)
            }
        } catch {
            // skip failed downloads
        }
    }

    return { imageDataUrls, audioDataUrls }
}
