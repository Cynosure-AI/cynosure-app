import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import {
    listAgents,
    getAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    duplicateAgent,
    getIconData,
    type CreateAgentInput,
    type UpdateAgentInput,
} from '../core/agents/agent-store.js'
import { getCronJobsForAgent, unscheduleCronJob } from '../core/triggers/cron-scheduler.js'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { getHITLGate } from '../core/agent/hitl-gate.js'
import { getToolRegistry } from '../core/tools/tool-registry.js'
import { isBuiltInMemoryToolKey } from '../core/tools/built-in-tools.js'
import { makeOrchestrationTools } from '../core/tools/builtin/orchestration-tools.js'
import { listAllMemorySpaceRefs } from '../core/memory/memory-space-folders.js'

function defaultMemorySpaceIds(db = getDb()): string[] {
    return listAllMemorySpaceRefs(db).map((space) => space.id)
}

function ensureAgentMemoryDefaults(agentId: string, db = getDb()): string[] {
    const existing = db.prepare('SELECT space_id FROM agent_memory_spaces WHERE agent_id = ?').all(agentId) as { space_id: string }[]
    if (existing.length > 0) return existing.map((row) => row.space_id)

    const defaults = defaultMemorySpaceIds(db)
    const insert = db.prepare('INSERT OR IGNORE INTO agent_memory_spaces (agent_id, space_id) VALUES (?, ?)')
    for (const spaceId of defaults) insert.run(agentId, spaceId)
    return defaults
}

export async function registerAgentDefinitionRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/agents — list all
    app.get('/', async () => {
        const db = getDb()
        const agents = listAgents()
        for (const agent of agents) ensureAgentMemoryDefaults(agent.id, db)
        const allLinks = db.prepare('SELECT agent_id, space_id FROM agent_memory_spaces').all() as { agent_id: string; space_id: string }[]
        const linkMap = new Map<string, string[]>()
        for (const row of allLinks) {
            const arr = linkMap.get(row.agent_id) || []
            arr.push(row.space_id)
            linkMap.set(row.agent_id, arr)
        }
        return agents.map(a => ({ ...a, memorySpaces: linkMap.get(a.id) || [] }))
    })

    // GET /api/agents/:id — get single
    app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const agent = getAgent(req.params.id)
        if (!agent) {
            reply.code(404)
            return { error: 'Agent not found' }
        }
        const db = getDb()
        return { ...agent, memorySpaces: ensureAgentMemoryDefaults(agent.id, db) }
    })

    // GET /api/agents/:id/icon — serve agent icon
    app.get<{ Params: { id: string } }>('/:id/icon', async (req, reply) => {
        const icon = getIconData(req.params.id)
        if (!icon) {
            reply.code(404)
            return { error: 'No icon' }
        }
        reply.header('Content-Type', icon.mime)
        reply.header('Cache-Control', 'public, max-age=3600')
        return icon.data
    })

    // POST /api/agents — create
    app.post<{ Body: CreateAgentInput & { memorySpaces?: string[] } }>('/', async (req) => {
        const { memorySpaces, ...rest } = req.body
        const agent = createAgent(rest)
        const assignedMemorySpaces = memorySpaces !== undefined ? memorySpaces : defaultMemorySpaceIds()
        const db = getDb()
        const insert = db.prepare('INSERT OR IGNORE INTO agent_memory_spaces (agent_id, space_id) VALUES (?, ?)')
        for (const spaceId of assignedMemorySpaces) insert.run(agent.id, spaceId)
        getChannelManager().refreshAllCommands()
        return { ...agent, memorySpaces: assignedMemorySpaces }
    })

    // PUT /api/agents/:id — update
    app.put<{ Params: { id: string }; Body: UpdateAgentInput & { memorySpaces?: string[] } }>('/:id', async (req, reply) => {
        const { memorySpaces, ...rest } = req.body
        const agent = updateAgent(req.params.id, rest)
        if (!agent) {
            reply.code(404)
            return { error: 'Agent not found' }
        }
        // Sync memory space assignments if provided
        if (memorySpaces !== undefined) {
            const db = getDb()
            db.prepare('DELETE FROM agent_memory_spaces WHERE agent_id = ?').run(agent.id)
            const insert = db.prepare('INSERT OR IGNORE INTO agent_memory_spaces (agent_id, space_id) VALUES (?, ?)')
            for (const spaceId of memorySpaces) insert.run(agent.id, spaceId)
        }
        const db = getDb()
        const spaceRows = db.prepare('SELECT space_id FROM agent_memory_spaces WHERE agent_id = ?').all(agent.id) as { space_id: string }[]
        getChannelManager().refreshAllCommands()
        return { ...agent, memorySpaces: spaceRows.map(r => r.space_id) }
    })

    // POST /api/agents/:id/duplicate — duplicate
    app.post<{ Params: { id: string } }>('/:id/duplicate', async (req, reply) => {
        const agent = duplicateAgent(req.params.id)
        if (!agent) {
            reply.code(404)
            return { error: 'Agent not found' }
        }
        getChannelManager().refreshAllCommands()
        return agent
    })

    // DELETE /api/agents/:id — delete
    app.delete<{ Params: { id: string } }>('/:id', async (req) => {
        const { id } = req.params
        const db = getDb()
        db.prepare('UPDATE conversations SET agent_id = NULL WHERE agent_id = ?').run(id)
        // Unschedule and delete all cron jobs for this agent
        const agentCronJobs = getCronJobsForAgent(id)
        for (const job of agentCronJobs) {
            unscheduleCronJob(job.id)
        }
        db.prepare('DELETE FROM cron_jobs WHERE agent_id = ?').run(id)
        deleteAgent(id)
        getChannelManager().refreshAllCommands()
        return { success: true }
    })

    // ─── Tool approvals & listing (previously /api/agent/*) ──

    // GET /api/agents/tool-approvals — get all tool approval states
    app.get('/tool-approvals', async () => {
        const gate = getHITLGate()
        return gate.getAllApprovals()
    })

    // PUT /api/agents/tool-approvals — bulk-set tool approval states
    app.put<{ Body: Record<string, boolean> }>('/tool-approvals', async (req, reply) => {
        const approvals = req.body
        if (!approvals || typeof approvals !== 'object') {
            return reply.status(400).send({ error: 'Expected { toolName: boolean } map' })
        }
        const gate = getHITLGate()
        gate.setAutoApproveBulk(approvals)
        return { success: true }
    })

    // PUT /api/agents/tool-approvals/:toolName — set approval for a specific tool
    app.put<{ Params: { toolName: string }; Body: { autoApprove: boolean } }>(
        '/tool-approvals/:toolName',
        async (req, reply) => {
            const { toolName } = req.params
            const { autoApprove } = req.body
            if (typeof autoApprove !== 'boolean') {
                return reply.status(400).send({ error: 'Expected { autoApprove: boolean }' })
            }
            const gate = getHITLGate()
            gate.setAutoApprove(toolName, autoApprove)
            return { success: true, toolName, autoApprove }
        }
    )

    // GET /api/agents/tools — list registered tools
    app.get<{ Querystring: { includePolicyBuiltIns?: string } }>('/tools', async (req) => {
        const registry = getToolRegistry()
        const gate = getHITLGate()
        const approvals = gate.getAllApprovals()
        const includePolicyBuiltIns = req.query.includePolicyBuiltIns === 'true'
        const items = registry.listRegisteredTools()
            .filter((tool) => includePolicyBuiltIns || !isBuiltInMemoryToolKey(tool.key))

        const policyBuiltIns = includePolicyBuiltIns
            ? makeOrchestrationTools('').map((tool) => ({
                key: `builtin::${tool.name}`,
                name: tool.name,
                executionName: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                namespace: { id: 'builtin', label: 'Built-In' },
                ambiguous: false,
            }))
            : []

        return [...items, ...policyBuiltIns].map((tool) => ({
            key: tool.key,
            name: tool.name,
            executionName: tool.executionName,
            description: tool.description,
            parameters: tool.parameters,
            autoApprove: approvals[tool.executionName] ?? false,
            namespace: tool.namespace,
            ambiguous: tool.ambiguous,
        }))
    })
}
