import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../db/database.js'
import { createAgent } from '../agents/agent-store.js'
import { findDeliveryConversation, persistProactiveMessage, recordChannelDeliveries } from './channel-delivery.js'
import {
    archiveChannelConversation, DEFAULT_SESSION_IDLE_HOURS, findHomeConversation, resolveContinuedConversation, resolveHomeConversation, sessionIdleMsFromConfig, type ChannelSessionState,
} from './channel-session.js'
import { createProject, getProjectForConversation, setConversationProject } from '../projects/project-store.js'
import { CYNO_AGENT_ID } from '../agent/execution-preset.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-delivery-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
})
afterEach(() => {
    closeDb()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
})

function conversation(id: string, agentId: string | null = null): string {
    getDb().prepare("INSERT INTO conversations (id, title, agent_id, origin, created_at, updated_at) VALUES (?, 'Run', ?, 'cron', 0, 0)")
        .run(id, agentId)
    return id
}

function state(agentId: string, allowedAgentIds: string[] = [], sessionIdleMs = 0): ChannelSessionState<number> {
    return {
        channelType: 'telegram', channelId: 'tg', agentId, broadcast: vi.fn(), allowedAgentIds,
        activeExecutions: new Map(), agentOverride: new Map(), lastUsedAgent: new Map(), conversationTargets: new Map(),
        targetLocks: new Map(), pendingAttachments: new Map(), conversationSendQueue: new Map(), sessionIdleMs,
    }
}

const HOUR = 3_600_000

/** Backdate a chat and give it one user message `hoursAgo`. */
function userWroteHoursAgo(conversationId: string, hoursAgo: number): void {
    const at = Date.now() - hoursAgo * HOUR
    getDb().prepare('UPDATE conversations SET created_at = ? WHERE id = ?').run(at - HOUR, conversationId)
    getDb().prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', 'Hi', ?)")
        .run(`m-${conversationId}-${at}`, conversationId, at)
}

describe('channel deliveries', () => {
    test('a reply to any sent message part finds the source conversation', () => {
        conversation('cron-run')
        recordChannelDeliveries({ channelId: 'tg', target: '42', platformMessageIds: ['7', '8'], conversationId: 'cron-run' })

        expect(findDeliveryConversation('tg', '42', '8')).toBe('cron-run')
        expect(findDeliveryConversation('tg', '42', '9')).toBeNull()
        expect(findDeliveryConversation('tg', '43', '7')).toBeNull()
    })

    test('deliveries of a deleted conversation are not followed', () => {
        conversation('cron-run')
        recordChannelDeliveries({ channelId: 'tg', target: '42', platformMessageIds: ['7'], conversationId: 'cron-run' })
        getDb().prepare('DELETE FROM conversations WHERE id = ?').run('cron-run')

        expect(findDeliveryConversation('tg', '42', '7')).toBeNull()
    })

    test('a delivered message is saved into the thread of the agent the chat talks to', () => {
        const agent = createAgent({ name: 'Researcher' })
        const session = state(agent.id)
        const home = resolveHomeConversation(session, 42)
        expect(resolveHomeConversation(session, 42)).toEqual(home)
        expect(session.conversationTargets.get(home.conversationId)).toBe(42)

        persistProactiveMessage({ broadcast: session.broadcast, conversationId: home.conversationId, agentId: agent.id, content: '**Briefing:**\nNews' })

        expect(getDb().prepare('SELECT role, content, agent_id FROM messages WHERE conversation_id = ?').all(home.conversationId)).toEqual([{
            role: 'assistant', content: '**Briefing:**\nNews', agent_id: agent.id,
        }])
    })

    test('a Cyno thread is a conversation without an agent, set up from Cyno\'s profile', () => {
        const session = state(CYNO_AGENT_ID)
        const home = resolveHomeConversation(session, 42)

        expect(home.agentId).toBe(CYNO_AGENT_ID)
        expect(resolveHomeConversation(session, 42).conversationId).toBe(home.conversationId)
        const row = getDb().prepare('SELECT agent_id, execution_config_json FROM conversations WHERE id = ?').get(home.conversationId) as { agent_id: string | null; execution_config_json: string }
        expect(row.agent_id).toBeNull()
        expect(JSON.parse(row.execution_config_json)).toMatchObject({ autoToolRouting: true, autoMemory: true, systemPrompt: expect.stringContaining('Cyno') })
    })
})

describe('continued conversations', () => {
    test('keep their own agent when it is usable on the channel', () => {
        const own = createAgent({ name: 'Researcher' })
        const other = createAgent({ name: 'Other' })
        conversation('run', own.id)

        expect(resolveContinuedConversation(state(other.id), 'run')).toEqual({ conversationId: 'run', agentId: own.id })
        expect(resolveContinuedConversation(state(other.id, [other.id]), 'run')).toEqual({ conversationId: 'run', agentId: null })
    })

    test('runs without an agent continue as Cyno; missing conversations are not followed', () => {
        conversation('free-run')
        expect(resolveContinuedConversation(state('x'), 'free-run')).toEqual({ conversationId: 'free-run', agentId: CYNO_AGENT_ID })
        expect(resolveContinuedConversation(state('x'), 'missing')).toBeNull()
    })
})

describe('idle chats', () => {
    test('a chat idle past the limit starts over in the same project; a recent one continues', () => {
        const session = state(CYNO_AGENT_ID, [], 4 * HOUR)
        const first = resolveHomeConversation(session, 42).conversationId
        const project = createProject({ name: 'Laundry', createMemoryFolder: false })
        setConversationProject(first, project.id)

        userWroteHoursAgo(first, 3)
        expect(resolveHomeConversation(session, 42).conversationId).toBe(first)

        session.sessionIdleMs = 2 * HOUR
        const next = resolveHomeConversation(session, 42).conversationId
        expect(next).not.toBe(first)
        expect(getProjectForConversation(next)?.id).toBe(project.id)
        const archived = getDb().prepare("SELECT json_extract(metadata_json, '$.archived') AS archived FROM conversations WHERE id = ?").get(first) as { archived: number | null }
        expect(archived.archived).toEqual(expect.any(Number))
    })

    test('proactive messages do not keep a chat alive, and deliveries never start or revive one', () => {
        const session = state(CYNO_AGENT_ID, [], 4 * HOUR)
        const home = resolveHomeConversation(session, 42).conversationId
        expect(findHomeConversation(session, 42)?.conversationId).toBe(home)

        userWroteHoursAgo(home, 30)
        persistProactiveMessage({ broadcast: session.broadcast, conversationId: home, agentId: null, content: '**Briefing:**\nNews' })
        expect(findHomeConversation(session, 42)).toBeNull()

        archiveChannelConversation(session, 42, CYNO_AGENT_ID)
        expect(findHomeConversation(session, 42)).toBeNull()
        expect(getDb().prepare("SELECT COUNT(*) AS n FROM conversations WHERE origin = 'channel'").get()).toEqual({ n: 1 })
    })

    test('a chat with a running turn does not expire; a zero limit keeps chats until new', () => {
        const session = state(CYNO_AGENT_ID, [], HOUR)
        const home = resolveHomeConversation(session, 42).conversationId
        userWroteHoursAgo(home, 2)
        session.activeExecutions.set('exec', {
            exec: { id: 'exec', channelId: 'tg', agentId: CYNO_AGENT_ID, conversationId: home, model: null, startedAt: 0 },
            controller: new AbortController(),
        })
        expect(resolveHomeConversation(session, 42).conversationId).toBe(home)

        const unlimited = state(CYNO_AGENT_ID)
        const kept = resolveHomeConversation(unlimited, 7).conversationId
        userWroteHoursAgo(kept, 24 * 30)
        expect(resolveHomeConversation(unlimited, 7).conversationId).toBe(kept)
    })

    test('the idle limit comes from channel config, defaulting when missing or invalid', () => {
        expect(sessionIdleMsFromConfig({})).toBe(DEFAULT_SESSION_IDLE_HOURS * HOUR)
        expect(sessionIdleMsFromConfig({ sessionIdleHours: 12 })).toBe(12 * HOUR)
        expect(sessionIdleMsFromConfig({ sessionIdleHours: 0 })).toBe(0)
        expect(sessionIdleMsFromConfig({ sessionIdleHours: -1 })).toBe(DEFAULT_SESSION_IDLE_HOURS * HOUR)
        expect(sessionIdleMsFromConfig({ sessionIdleHours: 'soon' })).toBe(DEFAULT_SESSION_IDLE_HOURS * HOUR)
    })
})
