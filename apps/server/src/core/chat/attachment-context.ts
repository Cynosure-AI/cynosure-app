/**
 * How much attachment text goes to the model directly. A file whose text fits
 * a share of the model's context window is inlined;
 */
import type { LLMGateway } from '../gateway/gateway.js'
import { resolveProviderAndModel } from '../agent/pre-execution/execution-resolvers.js'
import { ATTACHMENT_TEXT_LIMITS } from '../runtime-limits.js'

/** Rough UTF-8 bytes per token, to turn a token budget into a text size. */
const BYTES_PER_TOKEN = 4

/**
 * Inline limit in bytes for one attachment. Each inlined file is resent with
 * every later turn, so the share stays small; without a known window the
 * fixed default applies.
 */
export function inlineAttachmentTextLimitFor(contextWindow: number | undefined): number {
    const { minInlineTextLimit, maxInlineTextLimit, defaultInlineTextLimit, inlineContextShare } = ATTACHMENT_TEXT_LIMITS
    if (!contextWindow || contextWindow <= 0) return defaultInlineTextLimit
    const limit = Math.floor(contextWindow * inlineContextShare * BYTES_PER_TOKEN)
    return Math.max(minInlineTextLimit, Math.min(maxInlineTextLimit, limit))
}

/** The model's context window, capped by the agent's max context tokens. Undefined when neither is known. */
export async function resolveContextWindow(input: {
    gateway: Pick<LLMGateway, 'getModelInfo'>
    providerId?: string
    model: string
    maxContextTokens: number | null
}): Promise<number | undefined> {
    let contextWindow: number | undefined
    try {
        contextWindow = (await input.gateway.getModelInfo(input.model, input.providerId)).contextLength
    } catch { /* model metadata is best-effort */ }
    if (input.maxContextTokens !== null) {
        contextWindow = contextWindow ? Math.min(contextWindow, input.maxContextTokens) : input.maxContextTokens
    }
    return contextWindow
}

/** Inline limit for the model a run will use: the agent's base model unless the run overrides it. */
export async function resolveInlineAttachmentTextLimit(input: {
    gateway: LLMGateway
    baseProviderId?: string
    baseModel?: string
    providerOverride?: string
    modelOverride?: string
    maxContextTokens: number | null
}): Promise<number> {
    let target: { providerId: string; model: string }
    try {
        target = resolveProviderAndModel(input)
    } catch {
        // No usable provider; the run reports that itself.
        return inlineAttachmentTextLimitFor(input.maxContextTokens ?? undefined)
    }
    return inlineAttachmentTextLimitFor(await resolveContextWindow({ gateway: input.gateway, ...target, maxContextTokens: input.maxContextTokens }))
}
