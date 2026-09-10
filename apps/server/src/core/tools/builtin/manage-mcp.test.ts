import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb } from '../../../db/database.js'
import { MANAGE_MCP_TOOL_NAME, makeManageMcpTool, manageMcp } from './manage-mcp.js'

describe('manage_mcp', () => {
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-manage-mcp-'))
    process.env.CYNOSURE_DATA_DIR = directory
  })

  afterEach(() => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(directory, { recursive: true, force: true })
  })

  test('exposes one optional, upsert-oriented management contract', () => {
    const tool = makeManageMcpTool()
    expect(tool.name).toBe(MANAGE_MCP_TOOL_NAME)
    expect(tool.parameters.required).toBeUndefined()
    expect((tool.parameters.properties as Record<string, { enum?: string[] }>).action.enum).toEqual([
      'upsert', 'list', 'remove',
    ])
    expect(tool.parameters.properties).toEqual(expect.objectContaining({
      action: expect.any(Object),
      serverId: expect.any(Object),
      command: expect.any(Object),
      args: expect.any(Object),
      url: expect.any(Object),
      env: expect.any(Object),
      enabled: expect.any(Object),
    }))
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test('installs disabled, updates by stable id, and patches environment keys', async () => {
    const installed = await manageMcp({
      name: 'Example MCP',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      env: { TOKEN: 'secret', REGION: 'eu' },
      enabled: false,
    })
    expect(installed.success).toBe(true)
    const installedPayload = JSON.parse(installed.output)
    expect(installedPayload.action).toBe('installed')
    expect(installedPayload).not.toHaveProperty('env')
    expect(installedPayload.envKeys).toEqual(['TOKEN', 'REGION'])

    const updated = await manageMcp({
      serverId: installedPayload.serverId,
      args: ['-y', '@example/mcp@2'],
      env: { TOKEN: null, OTHER: 'value' },
      enabled: false,
    })
    expect(updated.success).toBe(true)
    expect(JSON.parse(updated.output)).toEqual(expect.objectContaining({
      action: 'updated',
      serverId: installedPayload.serverId,
      args: ['-y', '@example/mcp@2'],
      envKeys: ['REGION', 'OTHER'],
    }))

    const row = getDb().prepare('SELECT env_json FROM mcp_servers WHERE id = ?').get(installedPayload.serverId) as { env_json: string }
    expect(JSON.parse(row.env_json)).toEqual({ REGION: 'eu', OTHER: 'value' })
  })

  test('retries by exact name as an upsert and supports list and remove', async () => {
    await manageMcp({ name: 'Local MCP', command: 'node', args: ['one.js'], enabled: false })
    const updated = await manageMcp({ name: 'Local MCP', args: ['two.js'], enabled: false })
    expect(JSON.parse(updated.output).action).toBe('updated')

    const listed = await manageMcp({ action: 'list' })
    const servers = JSON.parse(listed.output).servers
    expect(servers).toHaveLength(1)
    expect(servers[0].args).toEqual(['two.js'])

    const removed = await manageMcp({ action: 'remove', serverId: servers[0].serverId })
    expect(removed.success).toBe(true)
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mcp_servers').get()).toEqual({ count: 0 })
  })

  test('does not create a duplicate for an unknown follow-up id and redacts credential arguments', async () => {
    const missing = await manageMcp({ serverId: 'missing-id', command: 'node', enabled: false })
    expect(missing.success).toBe(false)
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mcp_servers').get()).toEqual({ count: 0 })

    const installed = await manageMcp({
      name: 'Credential MCP',
      command: 'npx',
      args: ['pkg', '--api-key', 'super-secret', '--header=Authorization: Bearer also-secret'],
      enabled: false,
    })
    expect(installed.output).not.toContain('super-secret')
    expect(installed.output).not.toContain('also-secret')
    expect(JSON.parse(installed.output).args).toEqual([
      'pkg', '--api-key', '[redacted]', '--header=Authorization: [redacted]',
    ])
  })
})
