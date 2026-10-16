import { describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../gateway/gateway.js'
import { inlineAttachmentTextLimitFor, resolveContextWindow, resolveInlineAttachmentTextLimit } from './attachment-context.js'

function gateway(contextLength: number | undefined): LLMGateway {
    const provider = { config: { id: 'p', defaultModel: 'default-model' } }
    return {
        getModelInfo: vi.fn(async () => ({ id: 'm', contextLength })),
        getProvider: vi.fn(() => provider),
        getLastUsedProvider: vi.fn(() => provider),
    } as unknown as LLMGateway
}

describe('inline attachment limit', () => {
    test('is a tenth of the context window in text bytes, within fixed bounds', () => {
        expect(inlineAttachmentTextLimitFor(200_000)).toBe(80_000)
        expect(inlineAttachmentTextLimitFor(32_000)).toBe(12_800)
        expect(inlineAttachmentTextLimitFor(2_000)).toBe(2_000)
        expect(inlineAttachmentTextLimitFor(2_000_000)).toBe(500_000)
    })

    test('falls back to the default without a known window', () => {
        expect(inlineAttachmentTextLimitFor(undefined)).toBe(24_000)
        expect(inlineAttachmentTextLimitFor(0)).toBe(24_000)
    })

    test('the agent cap shrinks the window and stands in for unknown model metadata', async () => {
        expect(await resolveContextWindow({ gateway: gateway(200_000), model: 'm', maxContextTokens: 50_000 })).toBe(50_000)
        expect(await resolveContextWindow({ gateway: gateway(undefined), model: 'm', maxContextTokens: 50_000 })).toBe(50_000)
        const failing = { getModelInfo: vi.fn(async () => { throw new Error('offline') }) }
        expect(await resolveContextWindow({ gateway: failing, model: 'm', maxContextTokens: null })).toBeUndefined()
    })

    test('uses the model the run overrides to, else the agent model', async () => {
        const gw = gateway(100_000)
        await resolveInlineAttachmentTextLimit({ gateway: gw, baseProviderId: 'p', baseModel: 'agent-model', maxContextTokens: null })
        expect(gw.getModelInfo).toHaveBeenLastCalledWith('agent-model', 'p')
        const limit = await resolveInlineAttachmentTextLimit({ gateway: gw, baseModel: 'agent-model', modelOverride: 'chat-model', maxContextTokens: null })
        expect(gw.getModelInfo).toHaveBeenLastCalledWith('chat-model', 'p')
        expect(limit).toBe(40_000)
    })

    test('a missing provider leaves the default limit', async () => {
        const broken = { getModelInfo: vi.fn(), getProvider: vi.fn(), getLastUsedProvider: vi.fn(() => { throw new Error('No providers') }) } as unknown as LLMGateway
        expect(await resolveInlineAttachmentTextLimit({ gateway: broken, maxContextTokens: null })).toBe(24_000)
    })
})
