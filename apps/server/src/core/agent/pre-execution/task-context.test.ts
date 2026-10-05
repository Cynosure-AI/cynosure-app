import { describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'
import { buildTaskContext } from './task-context.js'

describe('task context cancellation', () => {
    test('passes the execution signal to the router request and preserves aborts', async () => {
        const controller = new AbortController()
        const aborted = new DOMException('Cancelled', 'AbortError')
        const complete = vi.fn().mockRejectedValue(aborted)
        const gateway = { complete } as unknown as LLMGateway

        await expect(buildTaskContext({
            conversationId: 'conversation',
            gateway,
            providerId: 'provider',
            model: 'model',
            userQuery: 'Do the work',
            enabledModes: { tools: true, memories: false },
            signal: controller.signal,
        })).rejects.toBe(aborted)

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({ signal: controller.signal }),
            'provider',
        )
    })

    test('routes memory lookups by model intent instead of fixed-language keywords', async () => {
        const complete = vi.fn().mockResolvedValue({
            toolCalls: [{
                function: {
                    name: 'set_task_context',
                    arguments: JSON.stringify({
                        requiresTools: false,
                        requiresMemory: true,
                        memorySearchQueries: ['information about a close friend'],
                    }),
                }
            }]
        })
        const gateway = { complete } as unknown as LLMGateway

        await expect(buildTaskContext({
            conversationId: 'conversation',
            gateway,
            userQuery: 'Do you remember my best friend?',
            enabledModes: { tools: true, memories: true },
        })).resolves.toMatchObject({
            requiresTools: false,
            requiresMemory: true,
            memorySearchQueries: ['information about a close friend'],
        })
        expect(complete).toHaveBeenCalledOnce()
        const request = complete.mock.calls[0][0]
        expect(request.tools?.[0].parameters).toMatchObject({
            additionalProperties: false,
            required: ['requiresTools', 'requiresMemory'],
            properties: {
                requiresTools: { type: 'boolean' },
                requiresMemory: { type: 'boolean' },
                toolSearchQuery: { type: 'string' },
                memorySearchQueries: { type: 'array', maxItems: 2 },
            },
        })
    })

    test('drops redundant memory expansions before applying the query budget', async () => {
        const complete = vi.fn().mockResolvedValue({
            toolCalls: [{
                function: {
                    name: 'set_task_context',
                    arguments: JSON.stringify({
                        requiresMemory: true,
                        memorySearchQueries: ['project details', 'specific preference', 'related decision'],
                    }),
                }
            }]
        })
        const result = await buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'project details', enabledModes: { tools: false, memories: true },
        })
        expect(result?.memorySearchQueries).toEqual(['specific preference', 'related decision'])
    })

    test('can independently skip both automatic tools and automatic memory', async () => {
        const complete = vi.fn().mockResolvedValue({
            toolCalls: [{
                function: {
                    name: 'set_task_context',
                    arguments: JSON.stringify({
                        requiresTools: false,
                        requiresMemory: false,
                    }),
                }
            }]
        })
        const result = await buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'Explain recursion', enabledModes: { tools: true, memories: true },
        })

        expect(result).toMatchObject({
            requiresTools: false,
            requiresMemory: false,
        })
    })

    test('keeps tool routing focused on the requested capability', async () => {
        const complete = vi.fn().mockResolvedValue({
            toolCalls: [{
                function: {
                    name: 'set_task_context',
                    arguments: JSON.stringify({
                        requiresTools: true,
                        toolSearchQuery: 'send a message',
                    }),
                }
            }]
        })
        const result = await buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'Envía el mensaje', enabledModes: { tools: true, memories: false },
        })

        expect(result?.toolSearchQuery).toBe('send a message')
    })

    test('allows required modes to fall back to the original request without generated queries', async () => {
        const complete = vi.fn().mockResolvedValue({
            toolCalls: [{
                function: {
                    name: 'set_task_context',
                    arguments: JSON.stringify({ requiresTools: true, requiresMemory: true }),
                }
            }]
        })
        const result = await buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'Use what you know about me to update the project',
            enabledModes: { tools: true, memories: true },
        })

        expect(result).toEqual({
            requiresTools: true,
            requiresMemory: true,
            toolSearchQuery: undefined,
            memorySearchQueries: [],
        })
    })

    test('fails open when a required routing decision is missing', async () => {
        const complete = vi.fn().mockResolvedValue({
            toolCalls: [{
                function: {
                    name: 'set_task_context',
                    arguments: JSON.stringify({ toolSearchQuery: 'send a message' }),
                }
            }]
        })
        await expect(buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'Send this', enabledModes: { tools: true, memories: false },
        })).resolves.toBeNull()
    })

    test('lets the planning call choose toolsets and ignores unknown or empty choices', async () => {
        const toolsets = [
            { id: 'mcp:browser', label: 'Browser MCP', description: 'Browse pages' },
            { id: 'mcp:mail', label: 'Mail MCP', description: 'Send mail' },
        ]
        const respond = (toolsetIds: unknown) => vi.fn().mockResolvedValue({
            toolCalls: [{ function: { name: 'set_task_context', arguments: JSON.stringify({ requiresTools: true, toolsetIds }) } }],
        })
        const run = (complete: ReturnType<typeof respond>) => buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'Email me the page title', enabledModes: { tools: true, memories: false }, toolsets,
        })

        const complete = respond(['mcp:mail', 'mcp:browser'])
        await expect(run(complete)).resolves.toMatchObject({ toolsetIds: ['mcp:mail', 'mcp:browser'] })
        const request = complete.mock.calls[0][0]
        expect(request.tools?.[0].parameters.properties.toolsetIds).toMatchObject({
            items: { enum: ['mcp:browser', 'mcp:mail'] },
        })
        expect(request.messages[1].content).toContain('- mcp:mail: Mail MCP')

        await expect(run(respond(['mcp:unknown']))).resolves.toMatchObject({ requiresTools: true, toolsetIds: undefined })
        await expect(run(respond([]))).resolves.toMatchObject({ requiresTools: true, toolsetIds: undefined })
    })

    test('names the user so first-person memory requests can be searched by name', async () => {
        const complete = vi.fn().mockResolvedValue({ toolCalls: [{ function: {
            name: 'set_task_context',
            arguments: JSON.stringify({ requiresMemory: true, memorySearchQueries: ['Ada Lovelace employer history'] }),
        } }] })

        const result = await buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'Where did I work before?', enabledModes: { tools: false, memories: true }, userName: 'Ada Lovelace',
        })

        expect(result?.memorySearchQueries).toEqual(['Ada Lovelace employer history'])
        expect(complete.mock.calls[0][0].messages[0].content).toContain('The user is named "Ada Lovelace"')
    })
})
