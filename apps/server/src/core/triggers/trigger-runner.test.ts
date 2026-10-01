import Database from 'better-sqlite3'
import { expect, test, vi } from 'vitest'
import { applySchemaMigrations } from '../../db/migrations.js'
import { getDb } from '../../db/database.js'
import { persistChatEvent } from '../chat/transcript.js'
import type { ChatEventDraft } from '@shared/types'

vi.mock('../../db/database.js', () => ({ getDb: vi.fn() }))
vi.mock('../gateway/gateway.js', () => ({ getGateway: () => ({}) }))
vi.mock('../tools/tool-registry.js', () => ({ getToolRegistry: () => ({}) }))
vi.mock('../agent/pre-execution/execution-planner.js', () => ({
    planExecution: vi.fn().mockResolvedValue({
        messages: [], tools: [], providerId: 'provider', responseProvider: 'provider', responseModel: 'model',
    }),
}))
vi.mock('../agent/agent-executor.js', () => ({
    MAIN_AGENT_MAX_ROUNDS: 10,
    AgentExecutor: class {
        lastStreamId = 'final-round-stream'
        async run() {
            return {
                content: 'Housekeeping complete', thinking: 'Checked the graph', images: [],
                usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, contextTokens: 30,
            }
        }
    },
}))

import { runTriggerExecution } from './trigger-runner.js'

test('publishes a cron final reply with its saved ID and final round stream for history replay', async () => {
    const db = new Database(':memory:')
    applySchemaMigrations(db)
    vi.mocked(getDb).mockReturnValue(db)
    // Use the same event persistence boundary as the real broadcast handler.
    const broadcast = vi.fn((event: string, data: unknown) => {
        if (event === 'chat:event') persistChatEvent(db, data as ChatEventDraft)
    })
    try {
        const { conversationId } = await runTriggerExecution({
            agent: null,
            executionConfig: {
                allowedTools: [], subAgents: [], memoryFolderIds: [], systemPrompt: '',
                model: 'model', providerId: 'provider', thinkingEnabled: true,
                reasoningEffort: 'medium', autoToolRouting: false, autoMemory: false,
            },
            userContent: 'Run housekeeping', origin: 'cron', title: 'Housekeeping',
            systemPromptSuffix: '', broadcast, signal: new AbortController().signal, logPrefix: '[test]',
        })
        const saved = db.prepare('SELECT id, content, model FROM messages WHERE conversation_id = ? AND role = ?')
            .get(conversationId, 'assistant') as { id: string; content: string; model: string }
        expect(saved).toMatchObject({ content: 'Housekeeping complete', model: 'model' })
        const event = db.prepare("SELECT sequence, execution_id, event_json FROM chat_events WHERE conversation_id = ? AND json_extract(event_json, '$.item.id') = ?")
            .get(conversationId, saved.id) as { sequence: number; execution_id: string; event_json: string } | undefined
        expect(event).toBeDefined()
        expect(event?.execution_id).toBe('final-round-stream')
        expect(JSON.parse(event!.event_json)).toMatchObject({
            type: 'transcript-item', item: { id: saved.id, executionId: 'final-round-stream', role: 'assistant' },
        })
    } finally {
        db.close()
    }
})
