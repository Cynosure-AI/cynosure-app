import { describe, expect, test } from 'vitest'
import { configFromForm, emptyServerForm, formFromServer } from './mcp-server-form'

describe('mcp-server-form', () => {
  test('round-trips a remote server and keeps existing header env names', () => {
    const stored = {
      command: 'remote',
      args: ['--transport', 'sse', '--url', 'https://example.test/sse', '--header-env=X-Api-Key=EXAMPLE_API_KEY'],
      env: { EXAMPLE_API_KEY: 'k' },
    }
    const form = formFromServer(stored)
    expect(form).toEqual(expect.objectContaining({ transport: 'sse', url: 'https://example.test/sse', headers: 'X-Api-Key: k' }))
    expect(configFromForm(form, 'Renamed')).toEqual(stored)
  })

  test('migrates a legacy bearer token into an Authorization header', () => {
    const form = formFromServer({
      command: 'remote',
      args: ['--transport', 'streamable-http', '--url', 'https://example.test/mcp', '--bearer-token-env=MCP_EXAMPLE_TOKEN'],
      env: { MCP_EXAMPLE_TOKEN: 'tok' },
    })
    expect(form.headers).toBe('Authorization: Bearer tok')
    expect(configFromForm(form, 'Example')).toEqual({
      command: 'remote',
      args: ['--transport', 'streamable-http', '--url', 'https://example.test/mcp', '--header-env=Authorization=MCP_EXAMPLE_AUTHORIZATION'],
      env: { MCP_EXAMPLE_AUTHORIZATION: 'Bearer tok' },
    })
  })

  test('shows env references for header values that come from the process environment', () => {
    const form = formFromServer({ command: 'remote', args: ['--url', 'https://example.test/mcp', '--header-env=X-Key=GLOBAL_KEY'], env: {} })
    expect(form.headers).toBe('X-Key: ${GLOBAL_KEY}')
  })

  test('builds stdio configs from command, args and env lines', () => {
    const form = { ...emptyServerForm(), command: ' npx ', args: '-y\n\n pkg ', env: 'A=1\nB=x=y' }
    expect(configFromForm(form)).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { A: '1', B: 'x=y' } })
  })
})
