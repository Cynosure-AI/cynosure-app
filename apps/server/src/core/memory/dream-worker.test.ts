import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentExecutorConfig } from '../agent/agent-executor.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'

const mocks = vi.hoisted(() => ({
    run: vi.fn(), tool: vi.fn(), modelInfo: vi.fn(), active: [] as string[],
    agent: vi.fn(), scopes: [] as unknown[], defaultModel: 'provider-default',
}))
vi.mock('../gateway/gateway.js', () => ({ getGateway: () => ({
    getModelInfo: mocks.modelInfo,
    getProvider: (id: string) => id === 'provider' ? { config: { id, defaultModel: mocks.defaultModel } } : undefined,
}) }))
vi.mock('../agent/agent-executor.js', () => ({ AgentExecutor: class {
    constructor(private config: AgentExecutorConfig) {}
    run(messages: ChatMessage[]) { return mocks.run(this.config, messages) }
} }))
vi.mock('../../routes/instances.js', () => ({ listActiveInstances: () => mocks.active.map(conversationId => ({ conversationId })) }))
vi.mock('../agents/agent-store.js', () => ({ getAgent: mocks.agent }))
vi.mock('../tools/builtin/memory-tools.js', () => {
    const make = (name: string) => (opts: unknown) => {
        mocks.scopes.push(opts)
        return { name, description: name, parameters: {}, timeout: 1000,
            execute: (params: unknown) => mocks.tool(name, params, opts) }
    }
    return {
        makeMemorySearchTool: make('memory_search'), makeMemoryCreateTool: make('memory_create'),
        makeMemoryPatchTool: make('memory_patch'), makeMemoryDeleteTool: make('memory_delete'),
    }
})
import { closeDb, getDb } from '../../db/database.js'
import { getDreamConfig, saveDreamConfig, listDreamRuns, buildDreamBatch, type DreamInput } from './dream-store.js'
import { startDreamWorker, sweepDream, settleDreamWork, settleDreamRun, cancelDreamRun, cancelAllDreamRuns, invalidateDreamConversation, DREAM_IDLE_MS, DREAM_SWEEP_MS, DREAM_RETRY_BASE_MS, resolveDreamCategories, isDreamEligibleConversation } from './dream-worker.js'

let directory: string
let stop: (() => Promise<void>) | undefined
const broadcast = vi.fn()
function conversation(id = 'chat', executionConfig: object = {}, origin = 'chat', agentId: string | null = null) {
    getDb().prepare('INSERT INTO conversations(id, origin, agent_id, execution_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, origin, agentId, JSON.stringify(executionConfig), Date.now(), Date.now())
}
function message(id = 'm1', conversationId = 'chat', content = 'I prefer concise replies', role = 'user') {
    getDb().prepare('INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, conversationId, role, content, Date.now())
}
function enable() { return saveDreamConfig({ enabled: true, providerId: 'provider', model: 'model' }) }
async function ready() {
    conversation()
    enable()
    vi.setSystemTime(Date.now() + 1)
    message()
    vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
    stop = startDreamWorker(broadcast)
    await settleDreamWork()
}
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-dream-'))
    process.env.CYNOSURE_DATA_DIR = directory
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T10:00:00Z'))
    mocks.run.mockReset().mockResolvedValue({
        content: 'Nothing useful', provider: 'provider', model: 'model',
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    })
    mocks.tool.mockReset().mockResolvedValue({ success: true, output: 'Saved document note#abc123' })
    mocks.modelInfo.mockReset().mockResolvedValue({ contextLength: 16384 })
    mocks.agent.mockReset()
    mocks.defaultModel = 'provider-default'
    mocks.active = []
    mocks.scopes = []
    broadcast.mockClear()
    getDb()
})
afterEach(async () => {
    await stop?.()
    stop = undefined
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
})

describe('Dream worker', () => {
    test('defaults off and establishes a fresh persisted window on each enable', async () => {
        conversation()
        message('old')
        expect(getDreamConfig().enabled).toBe(false)
        stop = startDreamWorker(broadcast)
        await settleDreamWork()
        expect(mocks.run).not.toHaveBeenCalled()
        const first = enable()
        expect(first.startSequence).toBe(1)
        expect(enable().windowId).toBe(first.windowId)
        saveDreamConfig({ enabled: false, providerId: 'provider', model: 'model' })
        message('disabled')
        const second = enable()
        expect(second.windowId).not.toBe(first.windowId)
        expect(second.startSequence).toBe(2)
        closeDb()
        expect(getDreamConfig()).toEqual(second)
    })
    test('waits for inactivity, processes once, and never persists Dream chat messages', async () => {
        conversation()
        enable()
        message()
        stop = startDreamWorker(broadcast)
        await settleDreamWork()
        await vi.advanceTimersByTimeAsync(DREAM_IDLE_MS - 1)
        expect(mocks.run).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        await settleDreamWork()
        expect(mocks.run).toHaveBeenCalledTimes(1)
        expect(mocks.run.mock.calls[0][0]).toMatchObject({ saveMessages: false, emitEvents: false, maxRounds: 10, contextStrategy: 'none' })
        expect(listDreamRuns()[0]).toMatchObject({ status: 'completed', reviewed_count: 1 })
        expect((JSON.parse(listDreamRuns()[0].input_json) as DreamInput).sources[0].content).toBe('')
        expect(getDb().prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 })
        expect(getDb().prepare(`SELECT kind, provider, model, input_tokens, output_tokens, request_count FROM auxiliary_model_usage WHERE kind = 'dreaming'`).get()).toEqual({
            kind: 'dreaming', provider: 'provider', model: 'model', input_tokens: 120, output_tokens: 30, request_count: 1,
        })
        await vi.advanceTimersByTimeAsync(DREAM_SWEEP_MS)
        expect(mocks.run).toHaveBeenCalledTimes(1)
        expect(broadcast).toHaveBeenCalledWith('memory:dream-updated', expect.objectContaining({ status: 'completed' }))
    })
    test('resolves a provider-only selection to its default model when creating a run', async () => {
        conversation()
        saveDreamConfig({ enabled: true, providerId: 'provider', model: '' })
        message()
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await settleDreamWork()

        expect(listDreamRuns()[0]).toMatchObject({ provider_id: 'provider', model: 'provider-default', status: 'completed' })
        expect(mocks.run.mock.calls[0][0]).toMatchObject({ providerId: 'provider', model: 'provider-default' })
    })
    test('marks documents changed by Dream', async () => {
        getDb().prepare(`
            INSERT INTO memory_file_index
                (document_id, document_ref, category_id, file_name, content_hash, created_at)
            VALUES ('dream-doc', 'preference#dream', 'uncategorized', 'preference.md', 'hash', ?)
        `).run(Date.now())
        mocks.tool.mockImplementation(async (name: string, _params: unknown, opts: unknown) => {
            if (name === 'memory_create') {
                (opts as { onDocumentMutated?: (id: string) => void }).onDocumentMutated?.('dream-doc')
            }
            return { success: true, output: 'Saved document preference#dream' }
        })
        mocks.run.mockImplementation(async (config: AgentExecutorConfig) => {
            await config.tools.find(tool => tool.name === 'memory_search')!.execute({ query: 'preference' })
            await config.tools.find(tool => tool.name === 'memory_create')!.execute({ title: 'Preference', content: 'Concise replies' })
        })

        await ready()

        const row = getDb().prepare("SELECT dreamed_at FROM memory_file_index WHERE document_id = 'dream-doc'").get() as { dreamed_at: number }
        expect(row.dreamed_at).toBe(Date.now())
    })
    test('uses old messages only as context and excludes disabled-period history', async () => {
        conversation()
        message('old')
        enable()
        message('new')
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await settleDreamWork()
        const input = JSON.parse(listDreamRuns()[0].input_json)
        expect(input.sources.map((source: { id: string }) => source.id)).toEqual(['new'])
        const reviewInput = JSON.parse(mocks.run.mock.calls[0][1][1].content as string)
        expect(reviewInput.earlierContext).toContain('old')
        expect(input.context).toBe('')
    })
    test('skips active, scheduled, and opted-out agent conversations while including Free Chat and opted-in channels', async () => {
        enable()
        mocks.agent.mockImplementation((id: string) => id === 'dreaming-agent' ? { dreamingEnabled: true } : { dreamingEnabled: false })
        for (const id of ['active', 'free-chat', 'opted-out-agent', 'cron', 'channel']) {
            const agentId = id === 'opted-out-agent' ? 'ordinary-agent' : id === 'channel' ? 'dreaming-agent' : null
            conversation(id, {}, id === 'cron' ? 'cron' : id === 'channel' ? 'channel' : 'chat', agentId)
            message(`${id}-m`, id)
        }
        mocks.active = ['active']
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await settleDreamWork()
        expect(listDreamRuns().map(run => run.conversation_id).sort()).toEqual(['channel', 'free-chat'])
    })
    test('treats Free Chat as eligible and requires explicit agent opt-in', () => {
        mocks.agent.mockImplementation((id: string) => id === 'enabled' ? { dreamingEnabled: true } : { dreamingEnabled: false })
        expect(isDreamEligibleConversation({ agent_id: null })).toBe(true)
        expect(isDreamEligibleConversation({ agent_id: 'enabled' })).toBe(true)
        expect(isDreamEligibleConversation({ agent_id: 'disabled' })).toBe(false)
        expect(isDreamEligibleConversation({ agent_id: 'missing' })).toBe(false)
    })
    test('resolves Dream folders from conversation overrides, agent assignments, then Uncategorized', () => {
        mkdirSync(join(directory, 'data', 'memories', 'Assigned'), { recursive: true })
        getDb().prepare("INSERT INTO memory_folders(id, name, directory_path, created_at) VALUES ('assigned', 'Assigned', ?, ?)")
            .run(join(directory, 'data', 'memories', 'Assigned'), Date.now())
        getDb().prepare("INSERT INTO agent_memory_folders(agent_id, category_id) VALUES ('agent-with-space', 'assigned')").run()

        expect(resolveDreamCategories({ id: 'x', agent_id: 'agent-with-space', execution_config_json: '{"memoryFolderIds":["uncategorized"],"autoMemory":false}' })).toEqual([
            { id: 'uncategorized', name: 'Uncategorized', description: 'Memories that do not yet have a folder', folderPath: '' },
            { id: 'assigned', name: 'Assigned', folderPath: 'Assigned' },
        ])
        expect(resolveDreamCategories({ id: 'x', agent_id: 'agent-with-space', execution_config_json: '{"autoMemory":false}' })).toEqual([
            expect.objectContaining({ id: 'assigned', name: 'Assigned' }),
        ])
        expect(resolveDreamCategories({ id: 'x', agent_id: 'agent-without-space', execution_config_json: '{"memoryFolderIds":[],"autoMemory":false}' })).toEqual([
            { id: 'uncategorized', name: 'Uncategorized', description: 'Memories that do not yet have a folder', folderPath: '' },
            { id: 'assigned', name: 'Assigned', folderPath: 'Assigned' },
        ])
        expect(resolveDreamCategories({ id: 'x', agent_id: null, execution_config_json: '{"memoryFolderIds":["missing"]}' })).toEqual([])
        expect(resolveDreamCategories({ id: 'x', agent_id: null, execution_config_json: '{}' })).toEqual([
            { id: 'uncategorized', name: 'Uncategorized', description: 'Memories that do not yet have a folder', folderPath: '' },
            { id: 'assigned', name: 'Assigned', folderPath: 'Assigned' },
        ])
    })
    test('serializes sweeps and reviews oldest conversations first', async () => {
        enable()
        conversation('oldest'); message('a', 'oldest')
        vi.setSystemTime(Date.now() + 1000)
        conversation('newer'); message('b', 'newer')
        let release!: () => void
        mocks.run.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
        const sweep1 = sweepDream()
        expect(sweepDream()).toBe(sweep1)
        expect(listDreamRuns()[0].conversation_id).toBe('oldest')
        release()
        await settleDreamWork()
        expect(mocks.run).toHaveBeenCalledTimes(2)
    })
    test('records partial mutations and does not repeat an identical successful write on retry', async () => {
        mocks.run.mockImplementation(async (config: AgentExecutorConfig) => {
            await config.tools.find(tool => tool.name === 'memory_search')!.execute({ query: 'preference' })
            await config.tools.find(tool => tool.name === 'memory_create')!.execute({ title: 'Preference', content: 'Concise replies' })
            if (mocks.run.mock.calls.length === 1) throw new Error('Provider disconnected')
        })
        await ready()
        expect(listDreamRuns()[0].status).toBe('failed')
        expect(JSON.parse(listDreamRuns()[0].changes_json)).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(DREAM_RETRY_BASE_MS)
        await settleDreamWork()
        expect(listDreamRuns()).toHaveLength(1)
        expect(listDreamRuns()[0]).toMatchObject({ status: 'completed', attempt: 2 })
        expect(mocks.tool.mock.calls.filter(call => call[0] === 'memory_create')).toHaveLength(1)
    })
    test('retries with backoff at most three times without advancing failed progress', async () => {
        mocks.run.mockRejectedValue(new Error('Offline'))
        await ready()
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
        await settleDreamWork()
        expect(mocks.run).toHaveBeenCalledTimes(3)
        expect(listDreamRuns()[0]).toMatchObject({ status: 'failed', attempt: 3 })
        expect(listDreamRuns()[0].input_json).not.toContain('I prefer concise replies')
        expect(getDb().prepare('SELECT last_sequence FROM dream_progress').get()).toEqual({ last_sequence: 1 })
    })
    test('continues with later messages after a batch exhausts its retries', async () => {
        mocks.run.mockRejectedValue(new Error('Offline'))
        await ready()
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
        expect(mocks.run).toHaveBeenCalledTimes(3)

        mocks.run.mockResolvedValue({ content: 'Recovered' })
        message('m2', 'chat', 'A later preference')
        await vi.advanceTimersByTimeAsync(DREAM_IDLE_MS)
        await sweepDream()

        expect(mocks.run).toHaveBeenCalledTimes(4)
        const completed = listDreamRuns().find(run => run.status === 'completed')!
        expect((JSON.parse(completed.input_json) as DreamInput).sources.map(source => source.id)).toEqual(['m2'])
    })
    test('invalidates pending work and redacts copied text when conversation history changes', async () => {
        mocks.run.mockRejectedValueOnce(new Error('Offline'))
        await ready()
        const failed = listDreamRuns()[0]
        expect(failed.input_json).toContain('I prefer concise replies')

        await invalidateDreamConversation('chat')

        const invalidated = listDreamRuns()[0]
        expect(invalidated.status).toBe('cancelled')
        expect(invalidated.input_json).not.toContain('I prefer concise replies')
        expect((JSON.parse(invalidated.input_json) as DreamInput).sources[0].content).toBe('')
    })
    test('requires search before writing and passes scoped tools only', async () => {
        mocks.run.mockImplementation(async (config: AgentExecutorConfig) => {
            const result = await config.tools.find(tool => tool.name === 'memory_create')!.execute({})
            expect(result.success).toBe(false)
            expect(config.tools).toHaveLength(4)
            expect(config.tools.some(tool => /append|replace_range|remove_range|shell|knowledge/.test(tool.name))).toBe(false)
        })
        await ready()
        expect(mocks.tool).not.toHaveBeenCalled()
        expect(mocks.scopes).toEqual(expect.arrayContaining([expect.objectContaining({
            assignedFolders: [expect.objectContaining({ id: 'uncategorized', name: 'Uncategorized' })],
        })]))
    })
    test('cancels active work and skips its pending messages until new activity', async () => {
        mocks.run.mockImplementationOnce((config: AgentExecutorConfig) => new Promise((_, reject) => config.signal!.addEventListener('abort', () => reject(config.signal!.reason))))
        conversation(); enable(); message()
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
        expect(cancelDreamRun(listDreamRuns()[0].id)).toBe(true)
        await settleDreamWork()
        expect(listDreamRuns()[0].status).toBe('cancelled')
        await vi.advanceTimersByTimeAsync(DREAM_SWEEP_MS)
        expect(mocks.run).toHaveBeenCalledTimes(1)
        message('m2')
        await vi.advanceTimersByTimeAsync(DREAM_IDLE_MS)
        await sweepDream()
        expect(mocks.run).toHaveBeenCalledTimes(2)
        expect(JSON.parse(listDreamRuns().find(run => run.status === 'completed')!.input_json).sources[0].id).toBe('m2')
    })
    test('cancelling one review does not wait for the next conversation to finish', async () => {
        mocks.run.mockImplementation((config: AgentExecutorConfig) => new Promise((_, reject) => config.signal!.addEventListener('abort', () => reject(config.signal!.reason))))
        enable()
        conversation('a'); message('a1', 'a')
        conversation('b'); message('b1', 'b')
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
        const firstId = listDreamRuns()[0].id
        cancelDreamRun(firstId)
        await settleDreamRun(firstId)
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2))
        expect(listDreamRuns().find(run => run.conversation_id === 'b')?.status).toBe('running')
    })
    test('Stop All prevents the same sweep from starting another eligible review', async () => {
        mocks.run.mockImplementationOnce((config: AgentExecutorConfig) => new Promise((_, reject) => config.signal!.addEventListener('abort', () => reject(config.signal!.reason))))
        enable()
        conversation('a'); message('a1', 'a')
        conversation('b'); message('b1', 'b')
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
        expect(cancelAllDreamRuns()).toBe(1)
        await settleDreamWork()
        expect(mocks.run).toHaveBeenCalledTimes(1)
    })
    test('shutdown interrupts work and startup recovers the frozen review', async () => {
        mocks.run.mockImplementationOnce((config: AgentExecutorConfig) => new Promise((_, reject) => config.signal!.addEventListener('abort', () => reject(config.signal!.reason))))
        conversation(); enable(); message()
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
        await stop()
        expect(listDreamRuns()[0].status).toBe('interrupted')
        vi.setSystemTime(Date.now() + DREAM_RETRY_BASE_MS)
        stop = startDreamWorker(broadcast)
        await settleDreamWork()
        expect(listDreamRuns()[0]).toMatchObject({ status: 'completed', attempt: 2 })
    })
    test('message deletion cannot reuse the enablement cursor and hide new messages', async () => {
        conversation(); message('old'); enable()
        getDb().prepare('DELETE FROM messages').run()
        message('new')
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await settleDreamWork()
        expect(mocks.run).toHaveBeenCalledTimes(1)
        expect(JSON.parse(listDreamRuns()[0].input_json).sources[0].id).toBe('new')
    })
    test('a five-minute timeout fails the run and leaves its messages pending', async () => {
        mocks.run.mockImplementationOnce((config: AgentExecutorConfig) => new Promise((_, reject) => config.signal!.addEventListener('abort', () => reject(config.signal!.reason))))
        conversation(); enable(); message()
        vi.setSystemTime(Date.now() + DREAM_IDLE_MS)
        stop = startDreamWorker(broadcast)
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        await settleDreamWork()
        expect(listDreamRuns()[0]).toMatchObject({ status: 'failed', error: 'Dream review exceeded five minutes' })
        expect(getDb().prepare('SELECT last_sequence FROM dream_progress').get()).toEqual({ last_sequence: 0 })
    })
    test('rejects writes after disabling or changing the conversation scope', async () => {
        mocks.run.mockImplementation(async (config: AgentExecutorConfig) => {
            await config.tools.find(tool => tool.name === 'memory_search')!.execute({ query: 'preference' })
            getDb().prepare("UPDATE conversations SET execution_config_json = '{\"memoryFolderIds\":[\"missing\"]}' WHERE id = 'chat'").run()
            await expect(config.tools.find(tool => tool.name === 'memory_create')!.execute({ title: 'Blocked' })).rejects.toThrow('scope changed')
        })
        await ready()
        expect(mocks.tool.mock.calls.some(call => call[0] === 'memory_create')).toBe(false)
        expect(listDreamRuns()[0].status).toBe('failed')
    })
    test('splits oversized messages without dropping characters or subsequent messages', () => {
        const rows = [{ id: 'a', sequence: 1, role: 'user' as const, content: 'abcdefghij' }, { id: 'b', sequence: 2, role: 'assistant' as const, content: 'klm' }]
        const first = buildDreamBatch(rows, 0, 6)
        expect(first).toMatchObject({ endSequence: 1, endOffset: 6 })
        const second = buildDreamBatch(rows, first.endOffset, 6)
        expect(second).toMatchObject({ endSequence: 2, endOffset: 2 })
        const third = buildDreamBatch(rows.slice(1), second.endOffset, 6)
        expect(third).toMatchObject({ endSequence: 2, endOffset: 0 })
        expect([...first.sources, ...second.sources, ...third.sources].map(source => source.content).join('')).toBe('abcdefghijklm')
    })
})
