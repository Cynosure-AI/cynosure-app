import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { routeSkills, shouldRouteSkills } from '../../skills/skill-router.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'
import type { SkillData } from '../../skills/skill-store.js'

export interface ApplyAutoSkillRoutingInput {
    enabled: boolean
    conversationId: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    manualSkills: SkillData[]
    availableSkills: SkillData[]
    gateway: LLMGateway
    providerId?: string
    model: string
    routerModel?: string
}

export async function applyAutoSkillRouting(input: ApplyAutoSkillRoutingInput): Promise<SkillData[]> {
    const {
        enabled,
        conversationId,
        userQuery,
        recentMessages,
        manualSkills,
        availableSkills,
        gateway,
        providerId,
        model,
        routerModel,
    } = input

    if (!shouldRouteSkills(availableSkills, userQuery, { enabled })) {
        return manualSkills
    }

    const taskId = `skill_router_${nanoid()}`
    try {
        emitSkillRoutingStatus(conversationId, taskId)
        const routedSkills = await routeSkills({
            userQuery: userQuery || '',
            recentMessages: recentMessages || [],
            skills: availableSkills,
            gateway,
            providerId,
            model,
            routerModel,
        })

        const selectedSkills = mergeSkills(manualSkills, routedSkills)
        emitSkillRoutingSelection(conversationId, taskId, selectedSkills)
        return selectedSkills
    } catch (err) {
        console.warn('[skill-router] Routing failed, using manual skill list:', err)
        emitSkillRoutingSelection(conversationId, taskId, manualSkills)
        return manualSkills
    }
}

function mergeSkills(first: SkillData[], second: SkillData[]): SkillData[] {
    const byId = new Map(first.map((skill) => [skill.id, skill]))
    for (const skill of second) byId.set(skill.id, skill)
    return [...byId.values()]
}

function emitSkillRoutingStatus(conversationId: string, taskId: string): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status: 'routing-skills',
        message: 'Selecting relevant skills...',
    })
}

function emitSkillRoutingSelection(conversationId: string, taskId: string, skills: SkillData[]): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        toolCalls: skills.map((skill) => ({
            name: skill.name,
            arguments: JSON.stringify({
                type: 'skill',
                category: skill.category || undefined,
                description: skill.description || undefined,
            }),
        })),
    })
}
