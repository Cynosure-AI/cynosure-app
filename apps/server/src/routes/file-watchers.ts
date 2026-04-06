import type { FastifyInstance } from 'fastify'
import {
    listFileWatchers,
    getFileWatcher,
    createFileWatcher,
    updateFileWatcher,
    deleteFileWatcher,
    startWatcher,
    stopWatcher,
    cancelWatcherRun,
    getActiveWatcherRuns,
    isWatcherActive,
} from '../core/triggers/file-watcher.js'
import { getAgent } from '../core/agents/agent-files.js'

export async function registerFileWatcherRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/file-watchers — list all file watchers with agent info
    app.get('/', async () => {
        const watchers = listFileWatchers()
        const runs = new Set(getActiveWatcherRuns().map(r => r.watcherId))

        return watchers.map((w) => {
            const agent = getAgent(w.agentId)
            return {
                ...w,
                agentName: agent?.name || 'Unknown',
                agentIconUrl: agent?.iconUrl || null,
                isWatching: isWatcherActive(w.id),
                isRunning: runs.has(w.id),
            }
        })
    })

    // GET /api/file-watchers/active-runs — list executing runs
    app.get('/active-runs', async () => {
        return getActiveWatcherRuns()
    })

    // POST /api/file-watchers — create a new file watcher
    app.post<{
        Body: {
            name?: string
            agentId: string
            paths: string[]
            ignorePatterns?: string[]
            prompt?: string
            debounceMs?: number
            enabled?: boolean
            modelOverride?: string
            providerOverride?: string
        }
    }>('/', async (req, reply) => {
        const { agentId, paths } = req.body
        if (!agentId || !paths?.length) {
            reply.code(400)
            return { error: 'agentId and paths are required' }
        }
        const agent = getAgent(agentId)
        if (!agent) {
            reply.code(404)
            return { error: 'Agent not found' }
        }
        const watcher = createFileWatcher(req.body)
        if (watcher.enabled) startWatcher(watcher.id)
        return watcher
    })

    // PUT /api/file-watchers/:id — update a file watcher
    app.put<{
        Params: { id: string }
        Body: {
            name?: string
            paths?: string[]
            ignorePatterns?: string[]
            prompt?: string
            debounceMs?: number
            enabled?: boolean
            modelOverride?: string
            providerOverride?: string
        }
    }>('/:id', async (req, reply) => {
        const watcher = updateFileWatcher(req.params.id, req.body)
        if (!watcher) {
            reply.code(404)
            return { error: 'File watcher not found' }
        }
        // Restart watcher (will stop if now disabled or paths changed)
        if (watcher.enabled) {
            startWatcher(watcher.id)
        } else {
            stopWatcher(watcher.id)
        }
        return watcher
    })

    // DELETE /api/file-watchers/:id — delete a file watcher
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const deleted = deleteFileWatcher(req.params.id)
        if (!deleted) {
            reply.code(404)
            return { error: 'File watcher not found' }
        }
        return { success: true }
    })

    // POST /api/file-watchers/:id/start — manually start a watcher
    app.post<{ Params: { id: string } }>('/:id/start', async (req, reply) => {
        const watcher = getFileWatcher(req.params.id)
        if (!watcher) {
            reply.code(404)
            return { error: 'File watcher not found' }
        }
        startWatcher(watcher.id)
        return { success: true }
    })

    // POST /api/file-watchers/:id/stop — manually stop a watcher
    app.post<{ Params: { id: string } }>('/:id/stop', async (req, reply) => {
        const watcher = getFileWatcher(req.params.id)
        if (!watcher) {
            reply.code(404)
            return { error: 'File watcher not found' }
        }
        stopWatcher(watcher.id)
        return { success: true }
    })

    // POST /api/file-watchers/:id/cancel — cancel an active run
    app.post<{ Params: { id: string } }>('/:id/cancel', async (req, reply) => {
        const cancelled = cancelWatcherRun(req.params.id)
        if (!cancelled) {
            reply.code(404)
            return { error: 'No active run for this watcher' }
        }
        return { success: true }
    })
}
