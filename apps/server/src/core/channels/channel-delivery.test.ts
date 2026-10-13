import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../db/database.js'
import { createAgent } from '../agents/agent-store.js'
import { findDeliveryConversation, persistProactiveMessage, recordChannelDeliveries } from './channel-delivery.js'
import { CYNO_AGENT_ID, resolveContinuedConversation, resolveHomeConversation, type ChannelSessionState } from './channel-session.js'

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

function state(agentId: string, allowedAgentIds: string[] = []): ChannelSessionState<number> {
    return {
        channelType: 'telegram', channelId: 'tg', agentId, broadcast: vi.fn(), allowedAgentIds,
        activeExecutions: new Map(), agentOverride: new Map(), lastUsedAgent: new Map(), conversationTargets: new Map(),
        targetLocks: new Map(), pendingAttachments: new Map(), conversationSendQueue: new Map(),
    }
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
