import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../db/database.js'
import { createAgent, duplicateAgent, getAgent, updateAgent } from './agent-store.js'
import { AvatarConfigError } from './avatar-config.js'

let directory = ''
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cynosure-agent-router-'))
    process.env.CYNOSURE_DATA_DIR = directory
})
afterEach(async () => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(directory, { recursive: true, force: true })
})

test('new and unconfigured agents default to the agent model', () => {
    const agent = createAgent({ name: 'Default' })
    expect(agent).toMatchObject({ autoRouterProviderId: '__agent_provider__', autoRouterModel: '__agent_model__', dreamingEnabled: true })
    getDb().prepare("UPDATE agents SET auto_router_provider_id = '', auto_router_model = '' WHERE id = ?").run(agent.id)
    expect(getAgent(agent.id)).toMatchObject({ autoRouterProviderId: '__agent_provider__', autoRouterModel: '__agent_model__' })
})

test('agents can explicitly opt out of Dreaming', () => {
    expect(createAgent({ name: 'Opted out', dreamingEnabled: false })).toMatchObject({ dreamingEnabled: false })
})

test('creation and duplication retain explicit agent router overrides', () => {
    const agent = createAgent({ name: 'Custom', autoRouterProviderId: 'custom', autoRouterModel: 'custom-model', dreamingEnabled: true })
    expect(agent).toMatchObject({ autoRouterProviderId: 'custom', autoRouterModel: 'custom-model', dreamingEnabled: true })
    expect(duplicateAgent(agent.id)).toMatchObject({ autoRouterProviderId: 'custom', autoRouterModel: 'custom-model', dreamingEnabled: true })
})


test('legacy cron prompts stay out of agent data and survive unrelated updates', () => {
    const agent = createAgent({ name: 'Legacy' })
    getDb().prepare('UPDATE agents SET cron_prompt = ? WHERE id = ?').run('Old scheduled instructions', agent.id)

    expect(getAgent(agent.id)).not.toHaveProperty('cronPrompt')
    const updated = updateAgent(agent.id, { name: 'Renamed', systemPrompt: 'Current instructions' })
    expect(updated).toMatchObject({ name: 'Renamed', systemPrompt: 'Current instructions' })
    expect(updated).not.toHaveProperty('cronPrompt')
    expect(getDb().prepare('SELECT cron_prompt FROM agents WHERE id = ?').get(agent.id))
        .toEqual({ cron_prompt: 'Old scheduled instructions' })
    const copy = duplicateAgent(agent.id)!
    expect(copy).not.toHaveProperty('cronPrompt')
    expect(getDb().prepare('SELECT cron_prompt FROM agents WHERE id = ?').get(copy.id))
        .toEqual({ cron_prompt: '' })
})

test('avatar settings persist, survive unrelated updates, and are copied with the agent', () => {
    const agent = createAgent({ name: 'Blob', avatar: { seed: 'pebble', hue: 140, tone: null, shape: 'cloud' } })
    expect(agent.avatar).toEqual({ seed: 'pebble', hue: 140, tone: null, shape: 'cloud' })

    expect(updateAgent(agent.id, { name: 'Renamed' })?.avatar).toEqual(agent.avatar)
    expect(duplicateAgent(agent.id)?.avatar).toEqual(agent.avatar)

    // Nothing customised is stored as the default face.
    expect(updateAgent(agent.id, { avatar: { seed: '  ', hue: null, tone: null, shape: null } })?.avatar).toBeNull()
    expect(createAgent({ name: 'Plain' }).avatar).toBeNull()
})

test('invalid avatar settings are rejected', () => {
    expect(() => createAgent({ name: 'Bad', avatar: { seed: null, hue: 400, tone: null, shape: null } })).toThrow(AvatarConfigError)
    const agent = createAgent({ name: 'Ok' })
    expect(() => updateAgent(agent.id, { avatar: { shape: 'star' } as never })).toThrow(AvatarConfigError)
})

test('a hand-edited avatar column falls back to the default face', () => {
    const agent = createAgent({ name: 'Edited' })
    getDb().prepare('UPDATE agents SET avatar_json = ? WHERE id = ?').run('{"hue":"red"}', agent.id)
    expect(getAgent(agent.id)?.avatar).toBeNull()
})
