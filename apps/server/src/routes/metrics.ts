import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { ensurePricingLoaded, getModelCost, type ModelCost } from '../core/model-dev-fetcher.js'
import { getGateway } from '../core/gateway/gateway.js'
import type { ModelPricing } from '../core/gateway/providers/base.provider.js'

interface ModelUsage {
    provider: string
    model: string
    requestCount: number
    totalPromptTokens: number
    totalCompletionTokens: number
    estimatedCost: number | null
}

interface AuxiliaryModelUsage extends ModelUsage {
    kind: 'embedding' | 'reranker' | 'deep-research' | 'memory-router' | 'tool-router' | 'dreaming'
}

interface ToolUsage {
    toolName: string
    callCount: number
}

interface AgentUsage {
    agentId: string
    agentName: string | null
    conversationCount: number
    messageCount: number
}

interface DailyActivity {
    date: string
    conversations: number
    messages: number
    tokens: number
    estimatedCost: number | null
}

interface MetricsSummary {
    totals: {
        conversations: number
        messages: number
        promptTokens: number
        completionTokens: number
        totalTokens: number
        avgLatencyMs: number
        estimatedCost: number | null
        chatEstimatedCost: number | null
        memoryEstimatedCost: number | null
        autoRoutingEstimatedCost: number | null
        dreamingEstimatedCost: number | null
    }
    modelUsage: ModelUsage[]
    auxiliaryModelUsage: AuxiliaryModelUsage[]
    toolUsage: ToolUsage[]
    agentUsage: AgentUsage[]
    dailyActivity: DailyActivity[]
    originBreakdown: { origin: string; count: number }[]
}

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {

    // GET /api/metrics — return aggregated usage metrics
    // DELETE /api/metrics — reset usage by recording a new cutoff timestamp
    app.delete('/', async () => {
        const db = getDb()
        db.prepare(`
            INSERT INTO settings (key, value_json)
            VALUES ('metrics_reset_at', ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
        `).run(JSON.stringify(Date.now()))
        return { success: true }
    })

    app.get<{
        Querystring: { days?: string }
    }>('/', async (req) => {
        const db = getDb()
        const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365)

        // Load pricing data (cached, non-blocking on failure)
        await ensurePricingLoaded().catch(() => { /* pricing is best-effort */ })

        // Calendar-based: start of day in local timezone (not rolling 24h window)
        const now = new Date()
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
        const periodSinceMs = startOfToday - (days - 1) * 86_400_000

        // Respect the metrics reset cutoff if it is more recent than the period window
        const resetRow = db.prepare(`SELECT value_json FROM settings WHERE key = 'metrics_reset_at'`).get() as { value_json: string } | undefined
        const resetAt: number = resetRow ? JSON.parse(resetRow.value_json) : 0
        const sinceMs = Math.max(periodSinceMs, resetAt)

        // Build provider ID → { type, name } map so we can resolve UUIDs to
        // human-readable names and to the type strings expected by models.dev.
        const providerRows = db.prepare('SELECT id, type, name FROM providers').all() as {
            id: string; type: string; name: string
        }[]
        const providerInfoMap = new Map<string, { type: string; name: string }>()
        const providerTypeMap = new Map<string, string>()
        for (const row of providerRows) {
            providerInfoMap.set(row.id, { type: row.type, name: row.name })
            providerTypeMap.set(row.id, row.type)
        }

        // ── Totals ──────────────────────────────────────────────────────────

        const totals = db.prepare(`
            SELECT
                COUNT(DISTINCT conversation_id) as conversations,
                COUNT(*) as messages,
                COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as completion_tokens,
                COALESCE(AVG(CASE WHEN latency_ms > 0 THEN latency_ms END), 0) as avg_latency
            FROM messages
            WHERE created_at >= ?
        `).get(sinceMs) as {
            conversations: number
            messages: number
            prompt_tokens: number
            completion_tokens: number
            avg_latency: number
        }

        // ── Model usage (top models by request count) ───────────────────────

        // Fetch ALL model combinations (no LIMIT) so cost can be summed correctly.
        // The display table will be capped at 20 entries client-side/below.
        const modelUsage = db.prepare(`
            SELECT
                COALESCE(provider, 'unknown') as provider,
                COALESCE(model, 'unknown') as model,
                COUNT(*) as request_count,
                COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as total_completion_tokens
            FROM messages
            WHERE role = 'assistant' AND created_at >= ?
            GROUP BY provider, model
            ORDER BY request_count DESC
        `).all(sinceMs) as {
            provider: string
            model: string
            request_count: number
            total_prompt_tokens: number
            total_completion_tokens: number
        }[]

        // Keep per-request token counts for tier-aware cost calculation. A
        // grouped average can cross a long-context threshold incorrectly.
        const assistantCostRows = db.prepare(`
            SELECT
                COALESCE(provider, 'unknown') as provider,
                COALESCE(model, 'unknown') as model,
                COALESCE(prompt_tokens, 0) as prompt_tokens,
                COALESCE(completion_tokens, 0) as completion_tokens
            FROM messages
            WHERE role = 'assistant' AND created_at >= ?
        `).all(sinceMs) as {
            provider: string
            model: string
            prompt_tokens: number
            completion_tokens: number
        }[]
        const nativeGatewayCosts = new Map<string, ModelCost | null>()
        const gateway = getGateway()
        for (const row of assistantCostRows) {
            const providerInfo = providerInfoMap.get(row.provider)
            const key = `${row.provider}\u0000${row.model}`
            if (!['openrouter', 'requesty'].includes(providerInfo?.type || '') || nativeGatewayCosts.has(key)) continue
            try {
                const info = await gateway.getModelInfo(row.model, row.provider)
                nativeGatewayCosts.set(key, modelCostFromPricing(info.pricing))
            } catch {
                nativeGatewayCosts.set(key, null)
            }
        }
        const modelCostTotals = new Map<string, number>()
        for (const row of assistantCostRows) {
            const providerType = providerTypeMap.get(row.provider) ?? row.provider
            const nativeKey = `${row.provider}\u0000${row.model}`
            const pricing = nativeGatewayCosts.has(nativeKey)
                ? nativeGatewayCosts.get(nativeKey)
                : getModelCost(providerType, row.model)
            if (!pricing) continue
            const key = `${row.provider}\u0000${row.model}`
            modelCostTotals.set(
                key,
                (modelCostTotals.get(key) ?? 0) + estimateTokenCost(pricing, row.prompt_tokens, row.completion_tokens)
            )
        }

        const auxiliaryUsage = db.prepare(`
            SELECT
                kind,
                COALESCE(provider, 'unknown') as provider,
                COALESCE(model, 'unknown') as model,
                COALESCE(SUM(request_count), 0) as request_count,
                COALESCE(SUM(input_tokens), 0) as total_prompt_tokens,
                COALESCE(SUM(output_tokens), 0) as total_completion_tokens
            FROM auxiliary_model_usage
            WHERE created_at >= ?
            GROUP BY kind, provider, model
            ORDER BY request_count DESC
        `).all(sinceMs) as {
            kind: 'embedding' | 'reranker' | 'deep-research' | 'memory-router' | 'tool-router' | 'dreaming'
            provider: string
            model: string
            request_count: number
            total_prompt_tokens: number
            total_completion_tokens: number
        }[]

        // Tool calls are counted from the canonical event log.
        const toolEvents = db.prepare(`
            SELECT event_json FROM chat_events
            WHERE created_at >= ? AND json_extract(event_json, '$.type') = 'tool-calls'
        `).all(sinceMs) as { event_json: string }[]
        const toolCounts = new Map<string, number>()
        for (const row of toolEvents) {
            const event = JSON.parse(row.event_json) as { items?: Array<{ name: string }> }
            for (const call of event.items || []) {
                toolCounts.set(call.name, (toolCounts.get(call.name) || 0) + 1)
            }
        }

        const toolUsage = [...toolCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 30)
            .map(([toolName, callCount]) => ({ toolName, callCount }))

        // ── Agent usage ─────────────────────────────────────────────────────

        const agentUsage = db.prepare(`
            SELECT
                c.agent_id,
                COUNT(DISTINCT c.id) as conversation_count,
                COUNT(m.id) as message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            WHERE c.created_at >= ? AND c.agent_id IS NOT NULL
            GROUP BY c.agent_id
            ORDER BY conversation_count DESC
            LIMIT 20
        `).all(sinceMs) as {
            agent_id: string
            conversation_count: number
            message_count: number
        }[]

        // ── Daily activity (last N days) ────────────────────────────────────

        const dailyRows = db.prepare(`
            SELECT
                DATE(created_at / 1000, 'unixepoch') as date,
                COUNT(DISTINCT conversation_id) as conversations,
                COUNT(*) as messages,
                COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) as tokens
            FROM messages
            WHERE created_at >= ?
            GROUP BY date
            ORDER BY date ASC
        `).all(sinceMs) as {
            date: string
            conversations: number
            messages: number
            tokens: number
        }[]

        // Per-day model breakdown (only assistant messages have model set)
        // Include provider and separate token columns for per-day cost calculation
        const dailyModelRows = db.prepare(`
            SELECT
                DATE(created_at / 1000, 'unixepoch') as date,
                COALESCE(provider, '') as provider,
                model,
                1 as messages,
                COALESCE(prompt_tokens, 0) as prompt_tokens,
                COALESCE(completion_tokens, 0) as completion_tokens
            FROM messages
            WHERE role = 'assistant' AND created_at >= ? AND model IS NOT NULL
            ORDER BY date ASC, created_at ASC
        `).all(sinceMs) as {
            date: string
            provider: string
            model: string
            messages: number
            prompt_tokens: number
            completion_tokens: number
        }[]

        // Aggregate model breakdown by date+model (combine providers for display)
        const modelsByDate = new Map<string, { model: string; messages: number; tokens: number; estimatedCost: number | null }[]>()
        const dailyCostMap = new Map<string, number>()
        for (const row of dailyModelRows) {
            let arr = modelsByDate.get(row.date)
            if (!arr) { arr = []; modelsByDate.set(row.date, arr) }
            const totalTokens = row.prompt_tokens + row.completion_tokens

            const providerType = providerTypeMap.get(row.provider) ?? row.provider
            const nativeKey = `${row.provider}\u0000${row.model}`
            const pricing = nativeGatewayCosts.has(nativeKey)
                ? nativeGatewayCosts.get(nativeKey)
                : getModelCost(providerType, row.model)
            const cost = pricing
                ? estimateTokenCost(pricing, row.prompt_tokens, row.completion_tokens)
                : null

            if (cost !== null) {
                dailyCostMap.set(row.date, (dailyCostMap.get(row.date) ?? 0) + cost)
            }

            const existing = arr.find(m => m.model === row.model)
            if (existing) {
                existing.messages += row.messages
                existing.tokens += totalTokens
                if (cost !== null) {
                    existing.estimatedCost = (existing.estimatedCost ?? 0) + cost
                }
            } else {
                arr.push({ model: row.model, messages: row.messages, tokens: totalTokens, estimatedCost: cost })
            }
        }

        const dailyAuxiliaryRows = db.prepare(`
            SELECT
                DATE(created_at / 1000, 'unixepoch') as date,
                COALESCE(provider, '') as provider,
                model,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens
            FROM auxiliary_model_usage
            WHERE created_at >= ?
            GROUP BY date, provider, model
        `).all(sinceMs) as {
            date: string
            provider: string
            model: string
            input_tokens: number
            output_tokens: number
        }[]

        for (const row of dailyAuxiliaryRows) {
            const providerType = providerTypeMap.get(row.provider) ?? row.provider
            const pricing = getModelCost(providerType, row.model)
            const cost = pricing
                ? (row.input_tokens * pricing.input + row.output_tokens * pricing.output) / 1_000_000
                : null
            if (cost !== null) {
                dailyCostMap.set(row.date, (dailyCostMap.get(row.date) ?? 0) + cost)
            }
        }

        const dailyActivity = dailyRows.map(day => ({
            ...day,
            models: modelsByDate.get(day.date) ?? [],
            estimatedCost: dailyCostMap.get(day.date) ?? null,
        }))

        // ── Origin breakdown ────────────────────────────────────────────────

        const originBreakdown = db.prepare(`
            SELECT origin, SUM(count) AS count FROM (
                SELECT COALESCE(origin, 'chat') as origin, COUNT(*) as count
                FROM conversations
                WHERE created_at >= ?
                GROUP BY origin
                UNION ALL
                SELECT 'dreaming' as origin, COUNT(*) as count
                FROM dream_runs
                WHERE created_at >= ?
                HAVING COUNT(*) > 0
            )
            GROUP BY origin
            ORDER BY count DESC
        `).all(sinceMs, sinceMs) as { origin: string; count: number }[]

        // ── Assemble response ───────────────────────────────────────────────

        // Calculate per-model estimates using native gateway prices when
        // available and models.dev for the remaining providers.
        const modelUsageWithCost = modelUsage.map(m => {
            const providerInfo = providerInfoMap.get(m.provider)
            // Use the human-readable name for display; fall back to the type / stored value.
            const providerDisplay = providerInfo?.name ?? providerInfo?.type ?? m.provider
            const estimatedCost = modelCostTotals.get(`${m.provider}\u0000${m.model}`) ?? null
            return {
                provider: providerDisplay,
                model: m.model,
                requestCount: m.request_count,
                totalPromptTokens: m.total_prompt_tokens,
                totalCompletionTokens: m.total_completion_tokens,
                estimatedCost,
            }
        })

        const auxiliaryUsageWithCost = auxiliaryUsage.map(m => {
            const providerInfo = providerInfoMap.get(m.provider)
            const providerType = providerInfo?.type ?? m.provider
            const providerDisplay = providerInfo?.name ?? providerInfo?.type ?? m.provider
            const pricing = getModelCost(providerType, m.model)
            const estimatedCost = pricing
                ? (m.total_prompt_tokens * pricing.input + m.total_completion_tokens * pricing.output) / 1_000_000
                : null
            return {
                kind: m.kind,
                provider: providerDisplay,
                model: m.model,
                requestCount: m.request_count,
                totalPromptTokens: m.total_prompt_tokens,
                totalCompletionTokens: m.total_completion_tokens,
                estimatedCost,
            }
        })

        // Sum up all model costs that were resolvable (across ALL models, not just top 20)
        const chatEstimatedCost = modelUsageWithCost.reduce<number | null>((sum, m) => {
            if (m.estimatedCost === null) return sum
            return (sum ?? 0) + m.estimatedCost
        }, null)
        const memoryEstimatedCost = auxiliaryUsageWithCost.reduce<number | null>((sum, m) => {
            if (!['embedding', 'reranker', 'deep-research'].includes(m.kind) || m.estimatedCost === null) return sum
            return (sum ?? 0) + m.estimatedCost
        }, null)
        const autoRoutingEstimatedCost = auxiliaryUsageWithCost.reduce<number | null>((sum, m) => {
            if (!['memory-router', 'tool-router'].includes(m.kind) || m.estimatedCost === null) return sum
            return (sum ?? 0) + m.estimatedCost
        }, null)
        const dreamingEstimatedCost = auxiliaryUsageWithCost.reduce<number | null>((sum, m) => {
            if (m.kind !== 'dreaming' || m.estimatedCost === null) return sum
            return (sum ?? 0) + m.estimatedCost
        }, null)
        const totalEstimatedCost = chatEstimatedCost !== null || memoryEstimatedCost !== null || autoRoutingEstimatedCost !== null || dreamingEstimatedCost !== null
            ? (chatEstimatedCost ?? 0) + (memoryEstimatedCost ?? 0) + (autoRoutingEstimatedCost ?? 0) + (dreamingEstimatedCost ?? 0)
            : null

        const response: MetricsSummary = {
            totals: {
                conversations: totals.conversations,
                messages: totals.messages,
                promptTokens: totals.prompt_tokens,
                completionTokens: totals.completion_tokens,
                totalTokens: totals.prompt_tokens + totals.completion_tokens,
                avgLatencyMs: Math.round(totals.avg_latency),
                estimatedCost: totalEstimatedCost,
                chatEstimatedCost,
                memoryEstimatedCost,
                autoRoutingEstimatedCost,
                dreamingEstimatedCost,
            },
            modelUsage: modelUsageWithCost.slice(0, 20),
            auxiliaryModelUsage: auxiliaryUsageWithCost.slice(0, 20),
            toolUsage,
            agentUsage: agentUsage.map(a => ({
                agentId: a.agent_id,
                agentName: null, // resolved client-side from agent definitions
                conversationCount: a.conversation_count,
                messageCount: a.message_count,
            })),
            dailyActivity,
            originBreakdown,
        }

        return response
    })
}

function estimateTokenCost(pricing: ModelCost, promptTokens: number, completionTokens: number): number {
    const tier = [...(pricing.tiers ?? [])]
        .filter((candidate) => candidate.minInputTokens != null && promptTokens >= candidate.minInputTokens)
        .sort((a, b) => (b.minInputTokens ?? 0) - (a.minInputTokens ?? 0))[0]
    const input = tier?.input ?? pricing.input
    const output = tier?.output ?? pricing.output
    return (promptTokens * input + completionTokens * output) / 1_000_000
}

function modelCostFromPricing(pricing: ModelPricing | undefined): ModelCost | null {
    if (pricing?.prompt == null && pricing?.completion == null) return null
    // Unit-billed media models cannot be estimated from message token counts.
    if (
        (pricing.prompt ?? 0) === 0 &&
        (pricing.completion ?? 0) === 0 &&
        Object.values(pricing.skus ?? {}).some((value) => value > 0)
    ) return null
    return {
        input: (pricing.prompt ?? 0) * 1_000_000,
        output: (pricing.completion ?? 0) * 1_000_000,
        ...(pricing.tiers?.length ? {
            tiers: pricing.tiers.flatMap((tier) =>
                tier.prompt == null && tier.completion == null
                    ? []
                    : [{
                        input: (tier.prompt ?? pricing.prompt ?? 0) * 1_000_000,
                        output: (tier.completion ?? pricing.completion ?? 0) * 1_000_000,
                        ...(tier.minPromptTokens != null ? { minInputTokens: tier.minPromptTokens } : {})
                    }]
            )
        } : {})
    }
}
