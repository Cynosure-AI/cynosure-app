import { describe, expect, test, vi } from 'vitest'
import { makeAttachmentTools } from '../../artifacts/attachment-rag.js'
import { makePlanningTools } from './planning-tools.js'
import { makeNotificationTool } from './notification.js'
import { makeSearchAvailableMcpToolsTool } from './expand-available-toolset.js'

describe('internal tool behavior annotations', () => {
    test('declares complete annotations for dynamic internal tools', () => {
        const tools = [
            ...makePlanningTools('run'),
            ...makeAttachmentTools('conversation'),
            makeNotificationTool({ agentId: 'agent', conversationId: 'conversation', broadcast: vi.fn() }),
            makeSearchAvailableMcpToolsTool({ allTools: [], getLoadedToolNames: () => new Set() }),
        ]

        for (const tool of tools) {
            expect(tool.annotations, tool.name).toEqual(expect.objectContaining({
                readOnlyHint: expect.any(Boolean),
                destructiveHint: expect.any(Boolean),
                idempotentHint: expect.any(Boolean),
                openWorldHint: expect.any(Boolean),
            }))
            expect(tool.execution?.readOnly, tool.name).toBe(tool.annotations?.readOnlyHint)
        }
    })
})
