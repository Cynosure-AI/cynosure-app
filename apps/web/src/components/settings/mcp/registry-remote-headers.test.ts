import { describe, expect, test } from 'vitest'
import { planRemoteHeaders } from './registry-remote-headers'

describe('planRemoteHeaders', () => {
  test('asks for the whole value of a plain header', () => {
    const plan = planRemoteHeaders([{ name: 'X-Api-Key', description: 'API key', isRequired: true, isSecret: true }])

    expect(plan.args).toEqual(['--header-env=X-Api-Key=MCP_HEADER_X_API_KEY'])
    expect(plan.inputs).toEqual([{ name: 'MCP_HEADER_X_API_KEY', description: 'API key', required: true, secret: true }])
    expect(plan.buildEnv({ MCP_HEADER_X_API_KEY: 'abc' })).toEqual({ MCP_HEADER_X_API_KEY: 'abc' })
  })

  test('asks only for template variables and stores the expanded header value', () => {
    const plan = planRemoteHeaders([{
      name: 'Authorization',
      description: 'GitHub personal access token',
      isRequired: true,
      isSecret: true,
      value: 'Bearer {GITHUB_PERSONAL_ACCESS_TOKEN}',
      variables: { GITHUB_PERSONAL_ACCESS_TOKEN: { description: 'PAT', isRequired: true, isSecret: true } },
    }])

    expect(plan.args).toEqual(['--header-env=Authorization=MCP_HEADER_AUTHORIZATION'])
    expect(plan.inputs).toEqual([{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'PAT', required: true, secret: true }])
    expect(plan.envHints.map(hint => hint.name)).toEqual(['MCP_HEADER_AUTHORIZATION'])
    expect(plan.buildEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_123' })).toEqual({ MCP_HEADER_AUTHORIZATION: 'Bearer ghp_123' })
    expect(plan.buildEnv({})).toEqual({})
  })

  test('derives undeclared template variables from the value', () => {
    const plan = planRemoteHeaders([{ name: 'Authorization', isRequired: false, isSecret: true, value: 'Token {API_TOKEN}' }])

    expect(plan.inputs).toEqual([expect.objectContaining({ name: 'API_TOKEN', required: false, secret: true })])
    expect(plan.buildEnv({ API_TOKEN: 't' })).toEqual({ MCP_HEADER_AUTHORIZATION: 'Token t' })
  })
})
