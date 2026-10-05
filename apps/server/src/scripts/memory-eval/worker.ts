/**
 * Runs one evaluation condition inside a data-dir snapshot. Spawned by the
 * memory:eval CLI with CYNOSURE_DATA_DIR pointing at the snapshot, so every
 * app singleton (DB, LanceDB, settings) resolves to the copy.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '../../core/gateway/providers/base.provider.js'
import type { CaseRunResult, EvalCase, EvalChunk, EvalCondition } from './types.js'

export interface WorkerJob {
  cases: EvalCase[]
  condition: EvalCondition
  curator: { providerId?: string; model?: string }
  concurrency: number
  outPath: string
  /** Directory of cached planner results; the planner's output for a case does
   * not depend on the condition, so runs reuse it. Absent = no caching. */
  plannerCacheDir?: string
}

interface RoutingEntry {
  name: string
  details: { content?: string; sourceFile?: string; directoryPath?: string; chunkIndex?: number; selectionMethod?: string; matchScore?: number; scoreType?: string }
}

if (!process.env.CYNOSURE_DATA_DIR?.includes('cynosure-memory-eval-') || process.env.CYNOSURE_DISABLE_MEMORY_WATCHERS !== '1') {
  throw new Error('memory-eval worker must run inside a snapshot with watchers disabled')
}

const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as WorkerJob
const { getDb } = await import('../../db/database.js')
const { loadSavedProviders } = await import('../../routes/providers.js')
const { loadEmbeddingServiceFromDb } = await import('../../core/memory/embedding.js')
const { getRAGStore } = await import('../../core/memory/rag.js')
const { getMemoryReranker } = await import('../../core/memory/reranker.js')
const { getGateway } = await import('../../core/gateway/gateway.js')
const { getEventBus } = await import('../../core/telemetry/event-bus.js')
const { applyAutoMemoryRoutingWithEvidence } = await import('../../core/agent/pre-execution/auto-memory-routing.js')
const { removeLegacyMemoryAnalysis } = await import('../../core/memory/legacy-analysis-cleanup.js')
const { costUsd, mapLimit } = await import('./llm.js')
const { OVERRIDE_SETTING } = await import('../../core/memory/retrieval-options.js')
const { buildTaskContext } = await import('../../core/agent/pre-execution/task-context.js')
const { getUserSettings } = await import('../../core/user-settings.js')

loadSavedProviders()
loadEmbeddingServiceFromDb()
getMemoryReranker().saveConfig({ ...getMemoryReranker().getConfig(), enabled: job.condition.reranker })
if (job.condition.options) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(OVERRIDE_SETTING, JSON.stringify(job.condition.options))
}
await getRAGStore().initialize()
// Snapshots of an install from before the analysis removal get the same
// one-time cleanup the server runs on startup.
await removeLegacyMemoryAnalysis()

// Routing decisions are the pipeline's own record of candidates and selection.
const decisions = new Map<string, Array<{ phase: string; entries: RoutingEntry[] }>>()
getEventBus().on('chat:event', (event: unknown) => {
  const { conversationId, payload } = event as { conversationId: string; payload: { type?: string; phase?: string; entries?: RoutingEntry[] } }
  if (payload?.type !== 'routing-decision' || !payload.phase?.startsWith('memory')) return
  const list = decisions.get(conversationId) || []
  list.push({ phase: payload.phase, entries: payload.entries || [] })
  decisions.set(conversationId, list)
})

const startedAt = Date.now()
const gateway = getGateway()
const results = await mapLimit(job.cases, job.concurrency, async (item): Promise<CaseRunResult> => {
  const conversationId = `memory-eval:${job.condition.name}:${item.id}`
  const t0 = performance.now()
  try {
    const recentMessages = (item.recentMessages || []) as ChatMessage[]
    // Production plans the turn first; its expansions, key terms and
    // "memory not needed" decision all shape what memory routing sees.
    const plan = job.condition.planner ? await cachedPlan(item.query, recentMessages, () => buildTaskContext({
      conversationId,
      gateway,
      providerId: job.curator.providerId,
      model: job.curator.model,
      userQuery: item.query,
      recentMessages,
      enabledModes: { tools: false, memories: true },
      userName: getUserSettings().name,
    })) : null
    const routed = plan?.requiresMemory === false ? null : await applyAutoMemoryRoutingWithEvidence({
      enabled: true,
      conversationId,
      userQuery: item.query,
      retrievalQueries: plan ? [item.query, ...plan.memorySearchQueries] : undefined,
      recentMessages,
      gateway,
      providerId: job.curator.providerId,
      model: job.curator.model,
      memoryFolderIds: item.folderIds,
    })
    const events = decisions.get(conversationId) || []
    const candidateEvents = events.filter((event) => event.phase === 'memory-candidates')
    const finalCandidates = candidateEvents.at(-1)?.entries || []
    const finalContext = events.filter((event) => event.phase === 'memory-context').at(-1)?.entries || []
    return {
      caseId: item.id,
      condition: job.condition.name,
      ms: Math.round(performance.now() - t0),
      candidates: toChunks(finalCandidates),
      selected: toChunks(finalContext),
      selectionMethod: routed?.evidence[0]?.selectionMethod,
      correctiveRetry: candidateEvents.length > 1,
      injected: routed?.content || '',
    }
  } catch (err) {
    return { caseId: item.id, condition: job.condition.name, ms: Math.round(performance.now() - t0), candidates: [], selected: [], correctiveRetry: false, injected: '', error: String(err) }
  }
})

const curatorUsage = getDb().prepare(`
  SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output
  FROM auxiliary_model_usage WHERE kind IN ('memory-router', 'task-context') AND created_at >= ?
`).get(startedAt) as { input: number; output: number }
const rerankUsage = getDb().prepare(`
  SELECT COALESCE(SUM(request_count), 0) AS requests FROM auxiliary_model_usage WHERE kind = 'reranker' AND created_at >= ?
`).get(startedAt) as { requests: number }
writeFileSync(job.outPath, JSON.stringify({
  results,
  curatorUsd: await costUsd(job.curator, curatorUsage.input, curatorUsage.output),
  rerankRequests: rerankUsage.requests,
}))
process.exit(0)

type Plan = Awaited<ReturnType<typeof buildTaskContext>>

async function cachedPlan(query: string, recentMessages: ChatMessage[], plan: () => Promise<Plan>): Promise<Plan> {
  if (!job.plannerCacheDir) return plan()
  const key = createHash('sha1').update(JSON.stringify([job.curator.model, getUserSettings().name, query, recentMessages])).digest('hex')
  const path = join(job.plannerCacheDir, `${key}.json`)
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Plan
  const result = await plan()
  // Failed plans are not cached so a transient provider error is retried next run.
  if (result) writeFileSync(path, JSON.stringify(result))
  return result
}

function toChunks(entries: RoutingEntry[]): EvalChunk[] {
  return entries
    .filter((entry) => entry.details.sourceFile)
    .map((entry) => ({
      file: entry.details.sourceFile, folder: entry.details.directoryPath, chunkIndex: entry.details.chunkIndex, text: entry.details.content || '',
      score: entry.details.matchScore, scoreType: entry.details.scoreType,
    }))
}
