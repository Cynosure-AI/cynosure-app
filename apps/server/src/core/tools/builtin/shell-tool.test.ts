import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { closeDb } from '../../../db/database.js'
import { addFileAccessRoot, listFileAccessRoots, preflightFileToolAccess } from './file-access-policy.js'
import { makeShellTool } from './shell-tool.js'
import { getEventBus } from '../../telemetry/event-bus.js'
import { getBuiltInNamespace, getBuiltInToolKey } from '../built-in-tools.js'
import { makeFileTools } from './file-tools.js'
import { HITLGate } from '../../agent/hitl-gate.js'
import type { ToolCall } from '../../gateway/providers/base.provider.js'

let sandbox: string
let allowed: string
let outside: string
let previousDataDir: string | undefined

beforeEach(async () => {
    closeDb()
    previousDataDir = process.env.CYNOSURE_DATA_DIR
    sandbox = await fs.mkdtemp(path.join(tmpdir(), 'cynosure-shell-'))
    process.env.CYNOSURE_DATA_DIR = sandbox
    allowed = path.join(sandbox, 'allowed')
    outside = path.join(sandbox, 'outside')
    await fs.mkdir(allowed)
    await fs.mkdir(outside)
    await addFileAccessRoot(allowed)
})

afterEach(async () => {
    closeDb()
    if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR
    else process.env.CYNOSURE_DATA_DIR = previousDataDir
    await fs.rm(sandbox, { recursive: true, force: true })
})

describe('built-in shell access', () => {
    it('registers in its own namespace and runs in the requested working directory', async () => {
        expect(getBuiltInNamespace('shell_execute').id).toBe('builtin:shell')
        expect(getBuiltInToolKey('shell_execute')).toBe('builtin:shell::shell_execute')
        await fs.writeFile(path.join(outside, 'hello.txt'), 'hello')
        const result = await makeShellTool().execute({ command: 'cat hello.txt', cwd: outside })
        expect(result.success, result.output).toBe(true)
        expect(result.output).toContain('hello')
        expect(listFileAccessRoots()).toEqual([allowed])
        expect((await makeShellTool().execute({ command: 'cat hello.txt', cwd: outside, timeoutSeconds: 601 })).success).toBe(false)
    })

    it('sends shell calls through the regular tool approval gate', async () => {
        const gate = new HITLGate()
        const tool = { ...makeShellTool(), namespaceId: 'builtin:shell', originalName: 'shell_execute' }
        const command = `cat ${path.join(outside, 'hello.txt')}`
        const call: ToolCall = { id: 'shell-call', type: 'function', function: { name: 'shell_execute', arguments: JSON.stringify({ command, cwd: outside }) } }
        const requests: string[] = []
        const unsubscribe = getEventBus().on('hitl:request', event => {
            const request = event as { toolCalls: Array<{ function: { name: string; arguments: string }; fileAccess?: unknown }>; resolve: (result: { approved: boolean }) => void }
            requests.push(request.toolCalls[0].function.name)
            expect(request.toolCalls[0].fileAccess).toBeUndefined()
            expect(JSON.parse(request.toolCalls[0].function.arguments)).toEqual({ command, cwd: outside })
            request.resolve({ approved: true })
        })
        try {
            expect((await gate.requestApproval('task', [call], undefined, 'test', [tool])).approved).toBe(true)
            expect(requests).toEqual(['shell_execute'])
            gate.addSessionApproval('test', ['shell_execute'])
            expect((await gate.requestApproval('session-task', [call], undefined, 'test', [tool])).approved).toBe(true)
            expect(requests).toHaveLength(1)
            gate.setAutoApprove('shell_execute', true)
            expect((await gate.requestApproval('saved-task', [call], undefined, 'other-chat', [tool])).approved).toBe(true)
            expect(requests).toHaveLength(1)
            expect(listFileAccessRoots()).toEqual([allowed])
        } finally { unsubscribe() }
    })

    it('still uses a folder card for native file tools', async () => {
        const target = path.join(outside, 'secret.txt')
        await fs.writeFile(target, 'approved')
        const tool = { ...makeFileTools().find(candidate => candidate.name === 'file_read')!, namespaceId: 'builtin:files', originalName: 'file_read' }
        const call: ToolCall = { id: 'file-call', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: target }) } }
        const requests: string[] = []
        const unsubscribe = getEventBus().on('hitl:request', event => {
            const request = event as { toolCalls: Array<{ fileAccess?: { folder: string } }>; resolve: (result: { approved: boolean }) => void }
            requests.push(request.toolCalls[0].fileAccess?.folder || 'generic')
            request.resolve({ approved: true })
        })
        try {
            expect((await new HITLGate().requestApproval('task', [call], undefined, 'test', [tool])).approved).toBe(true)
            await preflightFileToolAccess({ toolName: 'file_read', arguments: { path: target }, conversationId: 'test' })
            expect((await tool.execute({ path: target })).success).toBe(true)
            expect(requests).toEqual([outside])
        } finally { unsubscribe() }
    })

    it('caps command output', async () => {
        await fs.writeFile(path.join(outside, 'large.txt'), 'x'.repeat(256 * 1024))
        const result = await makeShellTool().execute({ command: 'cat large.txt', cwd: outside })
        expect(result.success).toBe(false)
        expect(result.output).toContain('Output exceeded 128 KiB.')
        expect(result.output.length).toBeLessThan(132_000)
    })
})
