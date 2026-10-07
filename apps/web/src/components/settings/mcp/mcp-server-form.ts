/**
 * Conversion between the MCP add/edit form and the stored server config.
 *
 * Remote servers are stored as `command: "remote"` with args
 * `--transport <streamable-http|sse> --url <url> --header-env=<Name>=<ENV>`.
 * Header values live in `env`, so secrets never appear in the args that the
 * server list displays. Values may reference `${VAR}` from the server's
 * environment; the backend expands them when connecting.
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerFormState {
  transport: McpTransport
  command: string
  args: string
  env: string
  url: string
  headers: string
  /** Lower-cased header name → env var holding its value (kept stable across edits). */
  headerEnvNames: Record<string, string>
}

export interface McpServerConfigPayload {
  command: string
  args: string[]
  env: Record<string, string>
}

export const REMOTE_COMMAND = 'remote'

export function emptyServerForm(): McpServerFormState {
  return { transport: 'stdio', command: '', args: '', env: '', url: '', headers: '', headerEnvNames: {} }
}

export function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
}

export function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eqIdx = line.indexOf('=')
    if (eqIdx > 0) env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
  }
  return env
}

function textToLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

/** Parse `Header-Name: value` lines; lines without a colon are ignored. */
export function parseHeaderLines(text: string): Array<{ name: string; value: string }> {
  return textToLines(text).flatMap((line) => {
    const sepIdx = line.indexOf(':')
    if (sepIdx <= 0) return []
    const name = line.slice(0, sepIdx).trim()
    const value = line.slice(sepIdx + 1).trim()
    return name && value ? [{ name, value }] : []
  })
}

function argValue(args: string[], name: string): string | null {
  const eqArg = args.find(arg => arg.startsWith(`${name}=`))
  if (eqArg) return eqArg.slice(name.length + 1)
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}

export function isRemoteServer(server: { command: string }): boolean {
  return server.command === REMOTE_COMMAND
}

/** Load an existing server config into the form. */
export function formFromServer(server: McpServerConfigPayload): McpServerFormState {
  if (!isRemoteServer(server)) {
    return { ...emptyServerForm(), transport: 'stdio', command: server.command, args: server.args.join('\n'), env: envToText(server.env) }
  }

  const { args, env } = server
  const headerLines: string[] = []
  const headerEnvNames: Record<string, string> = {}
  args.forEach((arg, idx) => {
    if (arg.startsWith('--header=')) headerLines.push(arg.slice('--header='.length))
    else if (arg === '--header' && idx + 1 < args.length) headerLines.push(args[idx + 1])
    else if (arg.startsWith('--header-env=')) {
      const spec = arg.slice('--header-env='.length)
      const sepIdx = spec.indexOf('=')
      if (sepIdx <= 0) return
      const name = spec.slice(0, sepIdx)
      const envName = spec.slice(sepIdx + 1)
      headerEnvNames[name.toLowerCase()] = envName
      headerLines.push(`${name}: ${env[envName] ?? `\${${envName}}`}`)
    }
  })
  const bearerEnv = argValue(args, '--bearer-token-env')
  // Legacy bearer configs store the raw token; it becomes a regular header on save.
  if (bearerEnv && !headerLines.some(line => line.toLowerCase().startsWith('authorization:'))) {
    headerLines.push(`Authorization: Bearer ${env[bearerEnv] ?? `\${${bearerEnv}}`}`)
  }

  const url = argValue(args, '--url') || args.find(arg => /^https?:\/\//.test(arg)) || ''
  const transport = (argValue(args, '--transport') || '').startsWith('sse') ? 'sse' : 'http'
  return { ...emptyServerForm(), transport, url, headers: headerLines.join('\n'), headerEnvNames }
}

function envSlug(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function urlHost(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

/** Build the stored config from the form. `serverName` seeds env var names for new headers. */
export function configFromForm(form: McpServerFormState, serverName = ''): McpServerConfigPayload {
  if (form.transport === 'stdio') {
    return { command: form.command.trim(), args: textToLines(form.args), env: textToEnv(form.env) }
  }

  const url = form.url.trim()
  const args = ['--transport', form.transport === 'sse' ? 'sse' : 'streamable-http', '--url', url]
  const env: Record<string, string> = {}
  const prefix = envSlug(serverName.trim() || urlHost(url)) || 'REMOTE'
  for (const { name, value } of parseHeaderLines(form.headers)) {
    let envName = form.headerEnvNames[name.toLowerCase()] || `MCP_${prefix}_${envSlug(name) || 'HEADER'}`
    while (env[envName] !== undefined) envName = `${envName}_`
    args.push(`--header-env=${name}=${envName}`)
    env[envName] = value
  }
  return { command: REMOTE_COMMAND, args, env }
}

export function canSubmitServerForm(form: McpServerFormState): boolean {
  return form.transport === 'stdio'
    ? !!form.command.trim()
    : /^https?:\/\/\S+$/.test(form.url.trim())
}
