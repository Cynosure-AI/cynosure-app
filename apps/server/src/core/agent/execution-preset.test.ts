import { describe, expect, test } from 'vitest'
import type { AgentData } from '../agents/agent-store.js'
import { CYNO_PRESET, isCyno, snapshotChatExecutionPreset } from './execution-preset.js'

describe('chat execution presets', () => {
    test('free chat uses an immutable default definition and snapshots run selections', () => {
        const tools = ['files::read']
        const subAgents = [{ agentId: 'worker' }]
        const first = snapshotChatExecutionPreset(null, {
            tools, subAgents, autoToolRouting: true, autoMemory: true,
        })

        tools.push('files::write')
        subAgents[0].agentId = 'changed'
        first.tools.push('another')

        expect(isCyno(first)).toBe(true)
        expect(first.tools).toEqual(['files::read', 'another'])
        expect(first.subAgents).toEqual([{ agentId: 'worker' }])
        expect(CYNO_PRESET.tools).toEqual([])
        expect(CYNO_PRESET.subAgents).toEqual([])
        expect(Object.isFrozen(CYNO_PRESET)).toBe(true)
    })

    test('saved agent settings are copied into the execution preset', () => {
        const agent = {
            id: 'agent', name: 'Agent', internalName: 'agent',
            tools: ['files::read'], subAgents: [{ agentId: 'worker' }],
            autoToolRouting: false, autoMemory: false,
        } as AgentData
        const snapshot = snapshotChatExecutionPreset(agent, {
            tools: agent.tools, subAgents: agent.subAgents, autoToolRouting: true,
            autoMemory: true,
        })

        agent.tools.push('files::write')
        agent.subAgents[0].agentId = 'changed'

        expect(isCyno(snapshot)).toBe(false)
        expect(snapshot.tools).toEqual(['files::read'])
        expect(snapshot.subAgents).toEqual([{ agentId: 'worker' }])
        expect(snapshot.autoToolRouting).toBe(true)
        expect(snapshot.autoMemory).toBe(true)
    })
})
