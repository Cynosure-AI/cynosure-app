import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Interaction } from 'discord.js'
import type { DiscordCtx } from './discord/discord.channel.js'
import type { TelegramCtx } from './telegram/telegram.channel.js'
import type { SlackCtx } from './slack/slack.channel.js'

const data = vi.hoisted(() => ({
    projects: [{ id: 'p1', name: 'Garden' }, { id: 'p2', name: 'Nintendo News' }],
    setProject: vi.fn(),
    sendMessage: vi.fn(),
    sendPicker: vi.fn(),
    answerCallback: vi.fn(),
    editMessage: vi.fn(),
}))
vi.mock('../projects/project-store.js', () => ({
    listProjects: () => data.projects,
    getProjectForConversation: () => null,
    setConversationProject: data.setProject,
}))
vi.mock('./channel-session.js', async (original) => ({
    ...await original<typeof import('./channel-session.js')>(),
    resolveHomeConversation: () => ({ conversationId: 'conversation', agentId: 'agent' }),
    getAvailableAgents: () => [],
}))
vi.mock('../cyno/cyno-profile.js', async (original) => ({
    ...await original<typeof import('../cyno/cyno-profile.js')>(),
    getCynoProfile: () => ({ name: 'Cyno' }),
}))
vi.mock('./telegram/telegram.api.js', async (original) => ({
    ...await original<typeof import('./telegram/telegram.api.js')>(),
    sendMessage: data.sendMessage,
    sendMessageReturningId: data.sendPicker,
    answerCallbackQuery: data.answerCallback,
    editMessage: data.editMessage,
}))

import { projectSuggestions, runProjectSuggestion } from './channel-commands.js'
import { DiscordChannel, handleInteraction } from './discord/discord.channel.js'
import { handleCallbackQuery, handleCommand, registerBotCommands } from './telegram/telegram.channel.js'
import { registerProjectListeners, handleCommand as handleSlackCommand } from './slack/slack.channel.js'

beforeEach(() => {
    vi.clearAllMocks()
    data.projects = [{ id: 'p1', name: 'Garden' }, { id: 'p2', name: 'Nintendo News' }]
})

describe('live project suggestions', () => {
    test('filters case-insensitively, limits results, and reads additions/renames/deletions', () => {
        expect(projectSuggestions('NIN')).toEqual([{ name: 'Nintendo News', value: 'id:p2' }])
        data.projects = [{ id: 'p1', name: 'Renamed' }, { id: 'p3', name: 'New' }]
        expect(projectSuggestions('', 1)).toEqual([{ name: 'Renamed', value: 'id:p1' }])
        expect(projectSuggestions('new')).toEqual([{ name: 'New', value: 'id:p3' }])
        expect(projectSuggestions('Nintendo')).toEqual([])
    })

    test('resolves IDs after reordering/renaming, including reserved names; rejects stale selections', () => {
        const ctx = {} as SlackCtx
        data.projects = [{ id: 'p2', name: 'off' }, { id: 'p1', name: '2' }]
        expect(runProjectSuggestion(ctx, 'C1', 'id:p2', { bold: t => t })).toContain('Now working in off')
        expect(data.setProject).toHaveBeenCalledWith('conversation', 'p2')
        data.setProject.mockClear()
        expect(runProjectSuggestion(ctx, 'C1', 'id:deleted', { bold: t => t })).toContain('no longer available')
        expect(data.setProject).not.toHaveBeenCalled()
    })
})

describe('Discord native project command', () => {
    const ctx = { allowedUserIds: new Set(['user']) } as unknown as DiscordCtx
    const interaction = (overrides: object) => ({
        commandName: 'project', user: { id: 'user' }, channelId: 'C1',
        isAutocomplete: () => false, isChatInputCommand: () => false, isButton: () => false,
        ...overrides,
    }) as unknown as Interaction

    test('upserts an optional autocomplete command without replacing other commands', async () => {
        const create = vi.fn()
        await DiscordChannel.prototype.refreshCommands.call({ client: { application: { commands: { create } } } } as unknown as DiscordChannel)
        expect(create.mock.calls[0][0].toJSON()).toMatchObject({
            name: 'project', options: [{ name: 'project', autocomplete: true, required: false }],
        })
    })

    test('returns matching projects and withholds names from unauthorized users', async () => {
        const respond = vi.fn()
        await handleInteraction(ctx, interaction({ isAutocomplete: () => true, options: { getFocused: () => 'garden' }, respond }))
        expect(respond).toHaveBeenLastCalledWith([{ name: 'Garden', value: 'id:p1' }])
        await handleInteraction(ctx, interaction({ isAutocomplete: () => true, user: { id: 'outsider' }, respond }))
        expect(respond).toHaveBeenLastCalledWith([])
        data.projects = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: 'x'.repeat(110) }))
        await handleInteraction(ctx, interaction({ isAutocomplete: () => true, options: { getFocused: () => '' }, respond }))
        expect(respond.mock.calls.at(-1)![0]).toHaveLength(25)
        expect(respond.mock.calls.at(-1)![0][0].name).toHaveLength(100)
    })

    test.each(['id:p2', 'nintendo', '2', 'off', ''])('executes selected or typed argument %j', async value => {
        const editReply = vi.fn()
        await handleInteraction(ctx, interaction({ isChatInputCommand: () => true,
            options: { getString: () => value }, deferReply: vi.fn(), editReply }))
        if (['id:p2', 'nintendo', '2'].includes(value)) expect(data.setProject).toHaveBeenCalledWith('conversation', 'p2')
        expect(editReply).toHaveBeenCalledOnce()
    })

    test('denies unauthorized command execution', async () => {
        const reply = vi.fn()
        await handleInteraction(ctx, interaction({ isChatInputCommand: () => true, user: { id: 'outsider' }, reply }))
        expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
        expect(data.setProject).not.toHaveBeenCalled()
    })
})

describe('Telegram project picker', () => {
    const ctx = { allowedUserIds: new Set(['42']) } as unknown as TelegramCtx
    test('publishes project in the command menu', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true })
        vi.stubGlobal('fetch', fetchMock)
        try {
            await registerBotCommands(ctx)
            expect(JSON.parse(fetchMock.mock.calls[0][1].body).commands).toContainEqual(expect.objectContaining({ command: 'project' }))
        } finally { vi.unstubAllGlobals() }
    })
    test('/project sends one message whose buttons are the list', async () => {
        expect(await handleCommand(ctx, 42, '/project@bot')).toBe(true)
        expect(data.sendMessage).not.toHaveBeenCalled()
        expect(data.sendPicker).toHaveBeenCalledOnce()
        expect(data.sendPicker.mock.calls[0][2]).toContain('isn’t in a project')
        const rows = data.sendPicker.mock.calls[0][3].reply_markup.inline_keyboard
        expect(rows).toEqual([
            [{ text: 'Garden', callback_data: 'project:id:p1' }],
            [{ text: 'Nintendo News', callback_data: 'project:id:p2' }],
        ])
    })
    test('falls back to the text reply without projects', async () => {
        data.projects = []
        await handleCommand(ctx, 42, '/project')
        expect(data.sendPicker).not.toHaveBeenCalled()
        expect(data.sendMessage.mock.calls[0][2]).toContain('no projects yet')
    })
    test('pages in place and fetches current projects on each page', async () => {
        data.projects = Array.from({ length: 45 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` }))
        await handleCallbackQuery(ctx, { id: 'callback', from: { id: 42, first_name: 'User' },
            message: { message_id: 7, chat: { id: 42, type: 'private' } }, data: 'project:page:1' })
        expect(data.sendPicker).not.toHaveBeenCalled()
        expect(data.editMessage.mock.calls[0][2]).toBe(7)
        const rows = data.editMessage.mock.calls[0][4].reply_markup.inline_keyboard
        expect(rows[0][0].callback_data).toBe('project:id:p20')
        expect(rows.at(-1)).toHaveLength(2)
    })
    test('selects by stable ID and rejects callbacks outside the allowed private chat', async () => {
        const query = { id: 'callback', from: { id: 42, first_name: 'User' }, message: { message_id: 1, chat: { id: 42, type: 'private' } }, data: 'project:id:p2' }
        await handleCallbackQuery(ctx, query)
        expect(data.setProject).toHaveBeenCalledWith('conversation', 'p2')
        // The picker itself becomes the confirmation.
        expect(data.editMessage).toHaveBeenCalledWith(ctx, 42, 1, expect.stringContaining('Nintendo News'), { reply_markup: { inline_keyboard: [] } })
        data.setProject.mockClear()
        await handleCallbackQuery(ctx, { ...query, from: { id: 99, first_name: 'Unknown' } })
        await handleCallbackQuery(ctx, { ...query, message: { message_id: 1, chat: { id: -1, type: 'group' } } })
        expect(data.setProject).not.toHaveBeenCalled()
    })
})

describe('Slack project select', () => {
    function listeners() {
        const app = { command: vi.fn(), options: vi.fn(), action: vi.fn() }
        registerProjectListeners({ app } as unknown as SlackCtx)
        return app
    }
    test('registers slash command, returns a picker, and retains typed arguments', async () => {
        const app = listeners()
        expect(app.command.mock.calls[0][0]).toBe('/project')
        const respond = vi.fn()
        const handler = app.command.mock.calls[0][1]
        await handler({ command: { channel_id: 'C1', text: '' }, ack: vi.fn(), respond })
        expect(respond.mock.calls[0][0].blocks[0].accessory).toMatchObject({ type: 'external_select', min_query_length: 0 })
        await handler({ command: { channel_id: 'C1', text: 'garden' }, ack: vi.fn(), respond })
        expect(data.setProject).toHaveBeenCalledWith('conversation', 'p1')
    })
    test('loads filtered current options and applies selected IDs', async () => {
        const app = listeners()
        const ack = vi.fn()
        data.projects = [{ id: 'new', name: 'New project' }]
        await app.options.mock.calls[0][1]({ options: { value: 'NEW' }, ack })
        expect(ack).toHaveBeenCalledWith({ options: [{ text: { type: 'plain_text', text: 'New project' }, value: 'id:new' }] })
        const respond = vi.fn()
        await app.action.mock.calls[0][1]({ action: { type: 'external_select', selected_option: { value: 'id:new' } }, ack, body: { channel: { id: 'C1' } }, respond })
        expect(data.setProject).toHaveBeenCalledWith('conversation', 'new')
        expect(respond).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true, blocks: [] }))
    })
    test('offers the same select for existing !project text commands', async () => {
        const postMessage = vi.fn().mockResolvedValue({})
        const client = { chat: { postMessage } } as unknown as SlackCtx['app']['client']
        await handleSlackCommand({} as SlackCtx, 'C1', '!project', client, 'thread')
        expect(postMessage.mock.calls[0][0]).toMatchObject({ thread_ts: 'thread', blocks: [{ accessory: { type: 'external_select' } }] })
    })
})
