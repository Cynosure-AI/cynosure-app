import { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import type { ChannelProvider, ChannelStatus, ActiveChannelExecution, ActiveChannelExecutionEntry } from '../base.channel.js'
import { handleChannelCommand, type ChannelCommandStyle } from '../channel-commands.js'
import { cancelChannelExecution, cancelChannelExecutionsWhere } from '../channel-execution.js'
import { parseHITLActionId, resolveChannelHITL, subscribeChannelHITL, type BroadcastFn, type ChannelMedia, type ChannelSessionState, type ConversationSendFn } from '../channel-session.js'
import { receiveChannelMessage, type ChannelTransport } from '../channel-turn.js'
import { sendLongSlackMessage, uploadImage, extractAttachments } from './slack.api.js'

export interface SlackConfig {
    botToken: string
    appToken: string
    allowedAgentIds?: string[]
}

export interface PendingHITL {
    conversationId: string
    slackChannelId: string
    messageTs: string
    resolve: (result: { approved: boolean; reason?: string }) => void
}

/** Slack state; targets are Slack channel ids. */
export interface SlackCtx extends ChannelSessionState<string> {
    app: App
    botToken: string
    appToken: string
    botUserId?: string
    pendingHITL: Map<string, PendingHITL>
}

const SLACK_COMMAND_STYLE: ChannelCommandStyle = {
    bold: (text) => `*${text}*`,
    switchBackHint: 'Use `!start` to switch back.',
}

export async function handleCommand(
    ctx: SlackCtx,
    slackChannelId: string,
    text: string,
    client: WebClient,
    threadTs: string
): Promise<boolean> {
    return handleChannelCommand(ctx, slackChannelId, text, async (reply) => {
        await client.chat.postMessage({ channel: slackChannelId, text: reply, thread_ts: threadTs }).catch(() => { })
    }, SLACK_COMMAND_STYLE)
}

export interface SlackMessage {
    text?: string
    user?: string
    channel: string
    ts: string
    subtype?: string
    files?: { id: string; name?: string; mimetype?: string; url_private_download?: string; url_private?: string }[]
}

/** All bot output for a message goes into that message's thread. */
function createTransport(client: WebClient, channel: string, threadTs: string): ChannelTransport<string> {
    return {
        logTag: '[Slack]',
        previewLimit: 3000,
        messageLimit: 3000,
        bold: (text) => `*${text}*`,
        reply: async (text) => {
            const res = await client.chat.postMessage({ channel, text, thread_ts: threadTs }).catch(() => null)
            return res?.ts || null
        },
        send: async (text) => {
            const res = await client.chat.postMessage({ channel, text, thread_ts: threadTs }).catch(() => null)
            return res?.ts || null
        },
        edit: async (ts, text) => { await client.chat.update({ channel, ts, text }).catch(() => { }) },
        sendLong: (text) => sendLongSlackMessage(client, channel, text, threadTs),
        sendImages: async (images) => {
            for (const { dataUrl, name } of images) {
                await uploadImage(client, channel, dataUrl, name, threadTs).catch(e =>
                    console.warn('[Slack] Failed to upload image:', (e as Error).message))
            }
        },
    }
}

export async function handleMessage(ctx: SlackCtx, msg: SlackMessage, client: WebClient): Promise<void> {
    const text = (msg.text || '').trim()
    const files = msg.files ?? []

    await receiveChannelMessage(ctx, {
        target: msg.channel,
        text,
        senderName: msg.user || 'User',
        hasMedia: files.length > 0,
        extractMedia: () => extractAttachments(ctx, files),
        handleCommand: text.startsWith('!') || text.startsWith('/')
            ? () => handleCommand(ctx, msg.channel, text, client, msg.ts)
            : undefined,
        transport: createTransport(client, msg.channel, msg.ts),
    })
}

export function subscribeToHITL(ctx: SlackCtx): () => void {
    return subscribeChannelHITL(ctx, async (request, slackChannelId, toolNames) => {
        const result = await ctx.app.client.chat.postMessage({
            channel: slackChannelId,
            text: `🔐 *Tool approval required*\n\nThe agent wants to use: ${toolNames}\n\nApprove or deny?`,
            blocks: [
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: `🔐 *Tool approval required*\n\nThe agent wants to use: ${toolNames}` }
                },
                {
                    type: 'actions',
                    elements: [
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: '✅ Approve' },
                            style: 'primary',
                            action_id: `hitl:${request.taskId}:approve`
                        },
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: '❌ Deny' },
                            style: 'danger',
                            action_id: `hitl:${request.taskId}:deny`
                        }
                    ]
                }
            ]
        })
        if (result.ts) {
            ctx.pendingHITL.set(request.taskId, {
                conversationId: request.conversationId,
                slackChannelId,
                messageTs: result.ts,
                resolve: request.resolve,
            })
        }
    })
}

export async function handleHITLAction(ctx: SlackCtx, actionId: string, client: WebClient): Promise<void> {
    const action = parseHITLActionId(actionId)
    if (!action) return
    const pending = ctx.pendingHITL.get(action.taskId)
    if (!pending) return

    ctx.pendingHITL.delete(action.taskId)
    resolveChannelHITL(ctx.broadcast, pending, action.taskId, action.approved, 'Slack')

    const statusText = action.approved ? '✅ *Approved* — proceeding...' : '❌ *Denied* — the agent will try a different approach.'
    await client.chat.update({
        channel: pending.slackChannelId,
        ts: pending.messageTs,
        text: statusText,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: statusText } }]
    }).catch(() => { })
}

export class SlackChannel implements ChannelProvider {
    app: App
    botToken: string
    appToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    botUserId?: string
    readonly channelType = 'slack'
    activeExecutions = new Map<string, ActiveChannelExecutionEntry>()
    agentOverride = new Map<string, string>()
    lastUsedAgent = new Map<string, string>()
    pendingHITL = new Map<string, PendingHITL>()
    conversationTargets = new Map<string, string>()
    targetLocks = new Map<string, Promise<void>>()
    conversationSendQueue = new Map<string, ConversationSendFn>()
    pendingAttachments = new Map<string, ChannelMedia>()

    private connected = false
    private errorMsg?: string
    private botUsername?: string
    private hitlUnsub?: () => void

    constructor(
        channelId: string,
        agentId: string,
        config: SlackConfig,
        broadcast: BroadcastFn
    ) {
        this.channelId = channelId
        this.agentId = agentId
        this.botToken = config.botToken
        this.appToken = config.appToken
        this.broadcast = broadcast
        this.allowedAgentIds = config.allowedAgentIds ?? []

        this.app = new App({
            token: this.botToken,
            appToken: this.appToken,
            socketMode: true
        })
    }

    async start(): Promise<void> {
        const testResult = await this.test()
        if (!testResult.success) {
            this.connected = false
            this.errorMsg = testResult.error
            return
        }
        this.botUsername = testResult.username

        this.app.message(async ({ message, client }) => {
            if (message.subtype) return
            const msg = message as SlackMessage
            if (!msg.user) return
            if (!msg.text?.trim() && !msg.files?.length) return

            handleMessage(this, msg, client).catch((err) => {
                console.error(`[Slack] Error handling message: ${(err as Error).message}`)
            })
        })

        this.app.action(/^hitl:.+/, async ({ action, ack, client }) => {
            await ack()
            if (action.type !== 'button') return
            const actionId = 'action_id' in action ? (action as { action_id: string }).action_id : ''
            await handleHITLAction(this, actionId, client).catch(() => { })
        })

        try {
            await this.app.start()
            this.connected = true
            this.errorMsg = undefined
            this.hitlUnsub = subscribeToHITL(this)
        } catch (err) {
            this.connected = false
            this.errorMsg = (err as Error).message
        }
    }

    async stop(): Promise<void> {
        this.connected = false
        this.hitlUnsub?.()
        this.hitlUnsub = undefined
        cancelChannelExecutionsWhere(this.activeExecutions, () => true)
        this.conversationTargets.clear()
        this.targetLocks.clear()
        try { await this.app.stop() } catch { }
    }

    status(): ChannelStatus {
        return {
            connected: this.connected,
            error: this.errorMsg,
            username: this.botUsername
        }
    }

    getActiveExecutions(): ActiveChannelExecution[] {
        return Array.from(this.activeExecutions.values()).map(v => v.exec)
    }

    cancelExecution(executionId: string): boolean {
        return cancelChannelExecution(this.activeExecutions, executionId)
    }

    async test(): Promise<{ success: boolean; username?: string; error?: string }> {
        try {
            const testApp = new App({
                token: this.botToken,
                appToken: this.appToken,
                socketMode: true
            })
            const authResult = await testApp.client.auth.test({ token: this.botToken })
            if (authResult.user_id) this.botUserId = authResult.user_id
            try { await testApp.stop() } catch { }
            return { success: true, username: (authResult.user as string) || (authResult.bot_id as string) || 'Slack Bot' }
        } catch (err) {
            return { success: false, error: (err as Error).message }
        }
    }

    async sendNotification(target: string, text: string): Promise<void> {
        if (!this.connected) return
        try {
            await sendLongSlackMessage(this.app.client, target, text)
        } catch (err) {
            console.error(`[Slack] sendNotification failed: ${(err as Error).message}`)
        }
    }
}
