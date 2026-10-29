import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from '../../../db/database.js'
import { makePlanningTools } from './planning-tools.js'
import { makeNotificationTool } from './notification.js'
import { makeSearchAvailableMcpToolsTool } from './expand-available-toolset.js'
import { makeManageMcpTool } from './manage-mcp.js'
import { makeSessionContentTools } from './session-content-tools.js'

describe('internal tool behavior annotations', () => {
    let dataDir = ''

    // The notification tool lists channels from the database.
    beforeEach(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'cynosure-annotations-'))
        process.env.CYNOSURE_DATA_DIR = dataDir
    })

    afterEach(() => {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        rmSync(dataDir, { recursive: true, force: true })
    })

    test('exposes the simple planning tool contract', () => {
        const [tool] = makePlanningTools('run')

        expect(tool.name).toBe('todo_update')
        expect(tool.parameters).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['tasks'],
            properties: {
                tasks: { type: 'array' },
            },
        })
        expect(Object.keys(tool.parameters.properties as Record<string, unknown>)).toEqual(['objective', 'tasks'])
    })

    test('exposes the session content tool contract', () => {
        const tools = makeSessionContentTools('conversation')

        expect(tools.map((tool) => tool.name)).toEqual(['session_content_grep', 'session_content_read'])
        expect(tools[0].parameters.required).toEqual(['pattern'])
        expect(tools[1].parameters.required).toBeUndefined()
    })

    test('declares complete annotations for dynamic internal tools', () => {
        const tools = [
            ...makePlanningTools('run'),
            ...makeSessionContentTools('conversation'),
            makeNotificationTool({ conversationId: 'conversation', availableChannels: ['telegram'] }),
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
