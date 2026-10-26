import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, Events, Partials, SlashCommandBuilder, InteractionContextType } from 'discord.js'
import type { Interaction, Message } from 'discord.js'
import type { ChannelProvider, ChannelStatus, ActiveChannelExecution, ActiveChannelExecutionEntry } from '../base.channel.js'
import { handleChannelCommand, projectSuggestions, runProjectCommand, runProjectSuggestion, type ChannelCommandStyle } from '../channel-commands.js'
import { cancelChannelExecution, cancelChannelExecutionsWhere } from '../channel-execution.js'
import { parseHITLActionId, resolveChannelHITL, findHomeConversation, resolveHomeConversation, sessionIdleMsFromConfig, subscribeChannelHITL, type BroadcastFn, type ChannelMedia, type ChannelSessionState, type ConversationSendFn } from '../channel-session.js'
import { receiveChannelMessage, type ChannelTransport } from '../channel-turn.js'
import { sendLongMessage, dataUrlToBuffer, extractAttachments, type DiscordSendChannel } from './discord.api.js'

export interface DiscordConfig {
    botToken: string
    allowedAgentIds?: string[]
    /** Hours without a user message after which a chat starts over; 0 never. */
    sessionIdleHours?: number
    /** Discord user IDs permitted to use this bot, in servers and DMs. Empty means deny all. */
    allowedUserIds?: string[]
}

export interface PendingHITL {
    conversationId: string
    actions?: string
    discordChannelId: string
    messageId: string
    resolve: (result: { approved: boolean; reason?: string }) => void
}

/** Discord state; targets are Discord text-channel ids. */
export interface DiscordCtx extends ChannelSessionState<string> {
    client: Client
    botToken: string
    allowedUserIds: ReadonlySet<string>
    pendingHITL: Map<string, PendingHITL>
}

/** Normalize Discord user IDs (snowflakes) from persisted, user-supplied channel config. */
export function normalizeDiscordUserIds(value: unknown): string[] {
    if (!Array.isArray(value)) return []

    const ids = value
        .map((id) => typeof id === 'string' ? id.trim() : '')
        .filter((id) => /^\d{15,21}$/.test(id))

    return Array.from(new Set(ids))
}

export function isDiscordUserAllowed(allowedUserIds: ReadonlySet<string>, userId: string | undefined): boolean {
    return userId !== undefined && allowedUserIds.has(userId)
}

const DISCORD_COMMAND_STYLE: ChannelCommandStyle = {
    bold: (text) => `**${text}**`,
    switchBackHint: 'Use `!start` to switch back.',
}

export async function handleCommand(ctx: DiscordCtx, msg: Message, text: string): Promise<boolean> {
    return handleChannelCommand(ctx, msg.channel.id, text, async (reply) => {
        await msg.reply(reply).catch(() => { })
    }, DISCORD_COMMAND_STYLE)
}

function createTransport(msg: Message): ChannelTransport<Message> {
    const channel = 'send' in msg.channel ? msg.channel as DiscordSendChannel : null
    return {
        logTag: '[Discord]',
        messageLimit: 2000,
        reply: (text) => msg.reply(text).catch(() => null),
        send: async (text) => channel ? channel.send(text).catch(() => null) : null,
        edit: async (handle, text) => { await handle.edit(text).catch(() => { }) },
        sendImages: async (images) => {
            if (!channel) return
            const files = images.map(({ dataUrl, name }) => {
                const { buffer, ext } = dataUrlToBuffer(dataUrl)
                return { attachment: buffer, name: `${name}.${ext}` }
            })
            await channel.send({ files }).catch((e: Error) => console.warn('[Discord] Failed to send images:', e.message))
        },
        sendTyping: async () => {
            if ('sendTyping' in msg.channel) await msg.channel.sendTyping().catch(() => { })
        },
        typingIntervalMs: 5000,
    }
}

export async function handleMessage(ctx: DiscordCtx, msg: Message): Promise<void> {
    if (msg.author.id === ctx.client.user?.id || msg.author.bot) return
    if (!isDiscordUserAllowed(ctx.allowedUserIds, msg.author.id)) return
    const text = (msg.content || '').trim()
    const hasMedia = msg.attachments.size > 0
    if (!text && !hasMedia) return

    await receiveChannelMessage(ctx, {
        target: msg.channel.id,
        text,
        senderName: msg.member?.displayName || msg.author.username,
        hasMedia,
        extractMedia: () => extractAttachments(msg),
        handleCommand: text.startsWith('!') || text.startsWith('/') ? () => handleCommand(ctx, msg, text) : undefined,
        transport: createTransport(msg),
    })
}

export function subscribeToHITL(ctx: DiscordCtx): () => void {
    return subscribeChannelHITL(ctx, async (request, discordChannelId, actions) => {
        const channel = ctx.client.channels.cache.get(discordChannelId)
        if (!channel || !('send' in channel)) return

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`hitl:${request.taskId}:approve`)
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`hitl:${request.taskId}:deny`)
                .setLabel('Decline')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        )
        const sentMsg = await (channel as DiscordSendChannel).send({
            content: `🔐 **Approval needed**\n\nTo continue, I need permission for:\n${actions}\n\nWork is paused until you choose.`,
            components: [row],
        })
        ctx.pendingHITL.set(request.taskId, {
            conversationId: request.conversationId,
            actions,
            discordChannelId,
            messageId: sentMsg.id,
            resolve: request.resolve,
        })
    }, async (taskId, cancelled) => {
        const pending = ctx.pendingHITL.get(taskId)
        if (!pending) return
        ctx.pendingHITL.delete(taskId)
        const channel = ctx.client.channels.cache.get(pending.discordChannelId)
        if (!channel || !('messages' in channel)) return
        const message = await channel.messages.fetch(pending.messageId)
        await message.edit({ content: [cancelled ? '⏹ Approval no longer needed.' : '✓ Approval answered in Cynosure.', pending.actions].filter(Boolean).join('\n\n'), components: [] })
    })
}

export async function handleInteraction(ctx: DiscordCtx, interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete() && interaction.commandName === 'project') {
        const suggestions = isDiscordUserAllowed(ctx.allowedUserIds, interaction.user.id)
            ? projectSuggestions(interaction.options.getFocused()) : []
        await interaction.respond(suggestions.map(item => ({ ...item, name: item.name.slice(0, 100) })))
        return
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'project') {
        if (!isDiscordUserAllowed(ctx.allowedUserIds, interaction.user.id) || !interaction.channelId) {
            await interaction.reply({ content: 'You are not allowed to use this command.', ephemeral: true })
            return
        }
        await interaction.deferReply({ ephemeral: true })
        const value = interaction.options.getString('project') ?? ''
        const reply = value.startsWith('id:')
            ? runProjectSuggestion(ctx, interaction.channelId, value, DISCORD_COMMAND_STYLE)
            : runProjectCommand(ctx, interaction.channelId, value, DISCORD_COMMAND_STYLE)
        await interaction.editReply({ content: reply, allowedMentions: { parse: [] } })
        return
    }
    if (!interaction.isButton()) return
    const action = parseHITLActionId(interaction.customId)
    if (!action) return
    if (!isDiscordUserAllowed(ctx.allowedUserIds, interaction.user.id)) {
        await interaction.reply({ content: 'You are not allowed to answer this approval.', ephemeral: true }).catch(() => { })
        return
    }

    const pending = ctx.pendingHITL.get(action.taskId)
    if (!pending) {
        await interaction.reply({ content: 'This approval has already been handled.', ephemeral: true }).catch(() => { })
        return
    }

    ctx.pendingHITL.delete(action.taskId)
    resolveChannelHITL(ctx.broadcast, pending, action.taskId, action.approved, 'Discord')

    const decision = action.approved ? '✅ **Approved** — continuing…' : '❌ **Declined** — I’ll continue without these actions.'
    const statusText = [decision, pending.actions].filter(Boolean).join('\n\n')
    await interaction.update({ content: statusText, components: [] }).catch(() => { })
}

export class DiscordChannel implements ChannelProvider {
    client: Client
    botToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    sessionIdleMs: number
    allowedUserIds: ReadonlySet<string>
    readonly channelType = 'discord'
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
        config: DiscordConfig,
        broadcast: BroadcastFn
    ) {
        this.channelId = channelId
        this.agentId = agentId
        this.botToken = config.botToken
        this.broadcast = broadcast
        this.allowedAgentIds = config.allowedAgentIds ?? []
        this.sessionIdleMs = sessionIdleMsFromConfig(config)
        this.allowedUserIds = new Set(normalizeDiscordUserIds(config.allowedUserIds))
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ],
            // DM channels aren't cached up front; without this partial, DM messages are dropped.
            partials: [Partials.Channel]
        })
    }

    async start(): Promise<void> {
        if (this.allowedUserIds.size === 0) {
            this.connected = false
            this.errorMsg = 'Discord access is locked: add at least one allowed Discord user ID.'
            return
        }
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
            await this.refreshCommands()
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
        return cancelChannelExecution(this.activeExecutions, executionId)
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
        if (!this.client.application) throw new Error('Discord application is not ready')
        // POST upserts just this command, preserving any other application commands.
        await this.client.application.commands.create(new SlashCommandBuilder()
            .setName('project')
            .setDescription('Show or switch the project this chat works in')
            .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
            .addStringOption(option => option.setName('project')
                .setDescription('Project name, number, or off to leave')
                .setAutocomplete(true)))
    }

    async sendNotification(target: string, text: string): Promise<void> {
        if (!this.connected) return
        try {
            const ch = await this.client.channels.fetch(target)
            if (!ch?.isSendable()) return
            await sendLongMessage(ch, text)
        } catch (err) {
            console.error(`[Discord] sendNotification failed: ${(err as Error).message}`)
        }
    }

    homeConversation(target: string, create: boolean): { conversationId: string; agentId: string } | null {
        if (!target) return null
        return create ? resolveHomeConversation(this, target) : findHomeConversation(this, target)
    }
}
