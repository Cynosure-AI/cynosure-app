import { describe, expect, test, vi } from 'vitest'
import type { ExecutionRequest } from './execution-input.js'
import { toExecutionPlanInput } from './execution-input.js'

describe('execution request normalization', () => {
    test('flattens run overrides while preserving shared execution dependencies', () => {
        const request = {
            resolvedAgent: null,
            conversationId: 'conversation',
            broadcast: vi.fn(),
            abortSignal: new AbortController().signal,
            gateway: { id: 'gateway' },
            toolRegistry: { id: 'registry' },
            messages: [{ role: 'user', content: 'hello' }],
            userText: 'hello',
            eventMeta: { maCodename: 'researcher' },
            run: {
                providerOverride: 'provider',
                modelOverride: 'model',
                selectedToolKeys: ['tool'],
                hasExplicitToolAllowlist: true,
                autoToolRouting: false,
                autoMemory: true,
                thinkingEnabled: false,
                reasoningEffort: 'high',
                inlineAttachmentTextLimit: 12_000,
            },
        } as unknown as ExecutionRequest

        const result = toExecutionPlanInput(request)
        expect(result).toMatchObject({
            conversationId: 'conversation',
            userText: 'hello',
            providerOverride: 'provider',
            modelOverride: 'model',
            selectedToolKeys: ['tool'],
            hasExplicitToolAllowlist: true,
            autoToolRouting: false,
            autoMemory: true,
            thinkingEnabled: false,
            inlineAttachmentTextLimit: 12_000,
            eventMeta: { maCodename: 'researcher' },
        })
        expect(result.gateway).toBe(request.gateway)
        expect(result.toolRegistry).toBe(request.toolRegistry)
    })

    test('leaves omitted run options undefined', () => {
        const request = {
            resolvedAgent: null,
            conversationId: 'conversation',
            broadcast: vi.fn(),
            abortSignal: new AbortController().signal,
            gateway: {},
            toolRegistry: {},
            messages: [],
            userText: '',
        } as unknown as ExecutionRequest

        expect(toExecutionPlanInput(request)).toMatchObject({
            providerOverride: undefined,
            selectedToolKeys: undefined,
            autoMemory: undefined,
        })
    })
})
