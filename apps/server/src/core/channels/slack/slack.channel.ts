import { App } from '@slack/bolt'
import type { ChannelProvider, ChannelStatus, ActiveChannelExecution } from '../base.channel.js'
import type { SlackConfig, BroadcastFn, SlackCtx, PendingHITL } from './slack.types.js'
import { handleMessage, handleHITLAction, subscribeToHITL } from './slack.messaging.js'
import { sendLongSlackMessage } from './slack.api.js'

export class SlackChannel implements ChannelProvider {
    app: App
    botToken: string
    appToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    botUserId?: string
    activeExecutions = new Map<string, { exec: ActiveChannelExecution; controller: AbortController }>()
    channelAgentOverride = new Map<string, string>()
    channelLastUsedAgent = new Map<string, string>()
    pendingHITL = new Map<string, PendingHITL>()
    conversationToChannel = new Map<string, string>()
    channelLocks = new Map<string, Promise<void>>()
    conversationSendQueue = new Map<string, (fn: () => Promise<void>) => void>()
    pendingAttachments = new Map<string, { imageDataUrls: string[]; audioDataUrls: string[] }>()

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
            const msg = message as { text?: string; user?: string; channel: string; ts: string; subtype?: string; files?: { id: string; name?: string; mimetype?: string; url_private_download?: string; url_private?: string }[] }
            if (!msg.user) return
            if (!msg.text?.trim() && !msg.files?.length) return

            handleMessage(this as SlackCtx, msg, client).catch((err) => {
                console.error(`[Slack] Error handling message: ${(err as Error).message}`)
            })
        })

        this.app.action(/^hitl:.+/, async ({ action, ack, client, body }) => {
            await ack()
            if (action.type !== 'button') return
            const actionId = 'action_id' in action ? (action as { action_id: string }).action_id : ''
            await handleHITLAction(this as SlackCtx, actionId, client, body as unknown as Record<string, unknown>).catch(() => { })
        })

        try {
            await this.app.start()
            this.connected = true
            this.errorMsg = undefined
            this.hitlUnsub = subscribeToHITL(this as SlackCtx)
        } catch (err) {
            this.connected = false
            this.errorMsg = (err as Error).message
        }
    }

    async stop(): Promise<void> {
        this.connected = false
        this.hitlUnsub?.()
        this.hitlUnsub = undefined
        for (const [id, entry] of this.activeExecutions) {
            entry.controller.abort()
            this.activeExecutions.delete(id)
        }
        this.conversationToChannel.clear()
        this.channelLocks.clear()
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
        const entry = this.activeExecutions.get(executionId)
        if (entry) {
            entry.controller.abort()
            this.activeExecutions.delete(executionId)
            return true
        }
        return false
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
