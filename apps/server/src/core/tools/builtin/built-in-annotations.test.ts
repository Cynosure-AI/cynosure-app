import { describe, expect, test, vi } from 'vitest'
import { makeAttachmentTools } from '../../artifacts/attachment-rag.js'
import { makePlanningTools } from './planning-tools.js'
import { makeNotificationTool } from './notification.js'
import { makeSearchAvailableMcpToolsTool } from './expand-available-toolset.js'
import { makeManageMcpTool } from './manage-mcp.js'

describe('internal tool behavior annotations', () => {
    test('exposes the atomic planning tool contract', () => {
        const [tool] = makePlanningTools('run')

        expect(tool.name).toBe('todo_update')
        expect(tool.parameters).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['op'],
            properties: {
                op: { enum: ['set', 'add', 'update', 'remove', 'clear'] },
                afterTaskId: { type: 'string' },
            },
        })
    })

    test('exposes the consolidated attachment tool contract', () => {
        const tools = makeAttachmentTools('conversation')

        expect(tools.map((tool) => tool.name)).toEqual(['attachment_search', 'attachment_read'])
        expect(tools[0].parameters.required).toBeUndefined()
        expect(tools[0].parameters.properties).toHaveProperty('query')
        expect(tools[0].parameters.properties).toHaveProperty('attachmentId')
    })

    test('declares complete annotations for dynamic internal tools', () => {
        const tools = [
            ...makePlanningTools('run'),
            ...makeAttachmentTools('conversation'),
            makeNotificationTool({ agentId: 'agent', conversationId: 'conversation', broadcast: vi.fn() }),
            makeSearchAvailableMcpToolsTool({ allTools: [], getLoadedToolNames: () => new Set() }),
            makeManageMcpTool(),
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
