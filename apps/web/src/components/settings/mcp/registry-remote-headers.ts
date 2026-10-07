import type { McpRegistryServer } from '../../../api/types'

type RemoteHeader = NonNullable<NonNullable<McpRegistryServer['server']['remotes']>[number]['headers']>[number]

export type HeaderInput = {
  /** Key the user's value is collected under. */
  name: string
  description?: string
  required: boolean
  secret: boolean
}

export type RemoteHeaderPlan = {
  /** `--header-env=<Header>=<ENV>` args to append to the remote config. */
  args: string[]
  /** Fields to ask the user for. */
  inputs: HeaderInput[]
  /** Hints for the env vars actually stored on the server config. */
  envHints: { name: string; description?: string; required: boolean }[]
  /** Turn the user's input values into the env stored on the server config. */
  buildEnv: (values: Record<string, string | undefined>) => Record<string, string>
}

export function headerEnvName(header: string): string {
  return `MCP_HEADER_${header.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'VALUE'}`
}

const PLACEHOLDER = /\{([^{}]+)\}/g
const HAS_PLACEHOLDER = /\{[^{}]+\}/

function templateVariables(header: RemoteHeader): HeaderInput[] {
  const declared = header.variables || {}
  const names = new Set([...Object.keys(declared), ...[...header.value!.matchAll(PLACEHOLDER)].map(m => m[1])])
  return [...names].map(name => ({
    name,
    description: declared[name]?.description || header.description,
    required: declared[name]?.isRequired ?? header.isRequired,
    secret: declared[name]?.isSecret ?? header.isSecret,
  }))
}

/**
 * Plan how a registry remote's headers are collected and stored. A header with
 * a `value` template (e.g. `Bearer {TOKEN}`) asks only for its variables and
 * stores the expanded value; a plain header asks for the whole value.
 */
export function planRemoteHeaders(headers: RemoteHeader[] = []): RemoteHeaderPlan {
  const inputs: HeaderInput[] = []
  const resolvers: Array<(values: Record<string, string | undefined>, env: Record<string, string>) => void> = []

  for (const header of headers) {
    const envName = headerEnvName(header.name)
    if (header.value && HAS_PLACEHOLDER.test(header.value)) {
      const variables = templateVariables(header)
      for (const variable of variables) {
        if (!inputs.some(input => input.name === variable.name)) inputs.push(variable)
      }
      resolvers.push((values, env) => {
        if (variables.some(v => !values[v.name])) return
        env[envName] = header.value!.replace(PLACEHOLDER, (_, name: string) => values[name] || '')
      })
    } else {
      inputs.push({
        name: envName,
        description: header.description || `Value for ${header.name}`,
        required: header.isRequired,
        secret: header.isSecret,
      })
      resolvers.push((values, env) => {
        if (values[envName]) env[envName] = values[envName]!
      })
    }
  }

  return {
    args: headers.map(header => `--header-env=${header.name}=${headerEnvName(header.name)}`),
    inputs,
    envHints: headers.map(header => ({
      name: headerEnvName(header.name),
      description: header.description || `Value for ${header.name}`,
      required: header.isRequired,
    })),
    buildEnv: (values) => {
      const env: Record<string, string> = {}
      resolvers.forEach(resolve => resolve(values, env))
      return env
    },
  }
}
