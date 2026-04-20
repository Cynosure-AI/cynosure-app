import { Client, GatewayIntentBits, Events } from 'discord.js'
import type { ChannelProvider, ChannelStatus, ActiveChannelExecution } from '../base.channel.js'
import type { DiscordConfig, DiscordCtx } from './discord.types.js'
import { handleMessage, handleInteraction, subscribeToHITL } from './discord.messaging.js'

export class DiscordChannel implements ChannelProvider {
    client: Client
    botToken: string
    agentId: string
    channelId: string
    broadcast: DiscordCtx['broadcast']
    allowedAgentIds: string[]
    activeExecutions = new Map<string, { exec: ActiveChannelExecution; controller: AbortController }>()
    channelAgentOverride = new Map<string, string>()
    pendingHITL = new Map<string, { discordChannelId: string; messageId: string; resolve: (result: { approved: boolean; reason?: string }) => void }>()
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
        config: DiscordConfig,
        broadcast: DiscordCtx['broadcast']
    ) {
        this.channelId = channelId
        this.agentId = agentId
        this.botToken = config.botToken
        this.broadcast = broadcast
        this.allowedAgentIds = config.allowedAgentIds ?? []
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ]
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

        this.client.on(Events.MessageCreate, (msg) => {
            handleMessage(this, msg).catch((err) => {
                console.error(`[Discord] Error handling message: ${(err as Error).message}`)
            })
        })

        this.client.on(Events.InteractionCreate, (interaction) => {
            handleInteraction(this, interaction).catch(() => { })
        })

        try {
            await this.client.login(this.botToken)
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
        for (const [id, entry] of this.activeExecutions) {
            entry.controller.abort()
            this.activeExecutions.delete(id)
        }
        this.conversationToChannel.clear()
        this.channelLocks.clear()
        try { this.client.destroy() } catch { }
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
        const testClient = new Client({ intents: [GatewayIntentBits.Guilds] })
        try {
            await testClient.login(this.botToken)
            const username = testClient.user?.username || testClient.user?.tag
            testClient.destroy()
            return { success: true, username: username || 'Discord Bot' }
        } catch (err) {
            try { testClient.destroy() } catch { }
            return { success: false, error: (err as Error).message }
        }
    }

    async refreshCommands(): Promise<void> {
        return
    }
}
