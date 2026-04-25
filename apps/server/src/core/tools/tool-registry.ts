import type { ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'

export interface LLMToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolNamespace {
  id: string      // e.g. "builtin" or "mcp:<serverId>"
  label: string   // e.g. "Built-in" or "My MCP Server"
  description?: string // Optional longer description for UI/tool discovery purposes
}

export interface RegisteredToolInfo {
  /** Stable persisted identifier: `namespaceId::toolName` */
  key: string
  /** Original bare tool name from the provider/MCP server */
  name: string
  /** LLM-facing callable name (may be prefixed on collisions) */
  executionName: string
  description: string
  parameters: Record<string, unknown>
  namespace: ToolNamespace
  ambiguous: boolean
}

interface ToolEntry {
  tool: ToolDefinition
  namespace: ToolNamespace
}

/**
 * Global tool registry that supports multiple tools with the same bare name
 * from different namespaces. Agent and chat selections are stored as stable
 * composite keys (`namespace::name`). LLM-facing execution names are generated
 * at runtime and only prefixed when a bare-name collision exists.
 */
export class ToolRegistry {
  /** Primary storage: compositeKey → entry */
  private entries = new Map<string, ToolEntry>()
  /** Index: bareName → Set<compositeKey> */
  private nameIndex = new Map<string, Set<string>>()

  private compositeKey(namespace: ToolNamespace, toolName: string): string {
    return `${namespace.id}::${toolName}`
  }

  private safeSlugForNamespace(namespace: ToolNamespace): string {
    const labelSlug = namespace.label
      .toLowerCase()
      .replace(/^mcp[-_\s]+/i, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')

    const idSlug = namespace.id
      .replace(/^mcp:/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')

    return labelSlug || idSlug || 'server'
  }

  private safeIdSlugForNamespace(namespace: ToolNamespace): string {
    return namespace.id
      .replace(/^mcp:/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      || 'ns'
  }

  private executionNameFor(entry: ToolEntry, forcePrefix = false): string {
    const keys = this.nameIndex.get(entry.tool.name)
    const ambiguous = forcePrefix || ((keys?.size ?? 0) > 1)
    if (!ambiguous) return entry.tool.name

    // Derive a human-readable namespace prefix and disambiguate that prefix
    // itself if two namespaces would otherwise generate the same slug.
    const baseSlug = this.safeSlugForNamespace(entry.namespace)
    const sameSlugCollision = [...(keys || [])]
      .map(key => this.entries.get(key))
      .some(other => other && other.namespace.id !== entry.namespace.id && this.safeSlugForNamespace(other.namespace) === baseSlug)
    const uniqueSlug = sameSlugCollision
      ? `${baseSlug}_${this.safeIdSlugForNamespace(entry.namespace).slice(0, 8)}`
      : baseSlug

    return `${uniqueSlug}__${entry.tool.name}`
  }

  private aliasTool(key: string, entry: ToolEntry, executionName: string): ToolDefinition {
    const metadata = { registryKey: key, originalName: entry.tool.name, namespaceId: entry.namespace.id }
    if (executionName === entry.tool.name) return { ...entry.tool, ...metadata }
    return { ...entry.tool, ...metadata, name: executionName }
  }

  register(tool: ToolDefinition, namespace: ToolNamespace = { id: 'unknown', label: 'Unknown' }): void {
    const key = this.compositeKey(namespace, tool.name)

    // Re-registration can happen during reconnect/auth completion. Remove the
    // old key from the bare-name index first so Set sizes stay accurate.
    const previous = this.entries.get(key)
    if (previous) {
      const oldKeys = this.nameIndex.get(previous.tool.name)
      oldKeys?.delete(key)
      if (oldKeys?.size === 0) this.nameIndex.delete(previous.tool.name)
    }

    this.entries.set(key, { tool, namespace })

    if (!this.nameIndex.has(tool.name)) {
      this.nameIndex.set(tool.name, new Set())
    }
    this.nameIndex.get(tool.name)!.add(key)
  }

  unregisterByNamespace(namespaceId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.namespace.id === namespaceId) {
        this.entries.delete(key)
        const bare = entry.tool.name
        const keys = this.nameIndex.get(bare)
        if (keys) {
          keys.delete(key)
          if (keys.size === 0) this.nameIndex.delete(bare)
        }
      }
    }
  }

  /** Get a tool by stable registry key. */
  get(name: string): ToolDefinition | undefined {
    const direct = this.entries.get(name)
    return direct?.tool
  }

  getAll(): ToolDefinition[] {
    return [...this.entries.values()].map(e => e.tool)
  }

  getAllWithNamespaces(): { tool: ToolDefinition; namespace: ToolNamespace }[] {
    return [...this.entries.values()].map(({ tool, namespace }) => ({ tool, namespace }))
  }

  listRegisteredTools(): RegisteredToolInfo[] {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      name: entry.tool.name,
      executionName: this.executionNameFor(entry),
      description: entry.tool.description,
      parameters: entry.tool.parameters,
      namespace: entry.namespace,
      ambiguous: (this.nameIndex.get(entry.tool.name)?.size ?? 0) > 1,
    }))
  }

  getToolSchemas(): LLMToolSchema[] {
    return this.getToolDefinitions().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }))
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.resolveForExecution([...this.entries.keys()])
  }

  hasKey(key: string): boolean {
    return this.entries.has(key)
  }

  async execute(name: string, params: unknown): Promise<ToolResult> {
    const tool = this.get(name)
    if (!tool) {
      return { success: false, output: '', error: `Tool '${name}' not found` }
    }
    return tool.execute(params)
  }

  /**
   * Resolve selected registry keys into ToolDefinitions ready for LLM injection.
   *
   * Selection keys are always stable composite keys (`namespace::name`). The
   * returned ToolDefinitions keep the original execute implementation but may
   * receive an LLM-safe execution alias when the bare name is globally
   * ambiguous, e.g. `webfetch__fetch`.
   */
  resolveForExecution(selectedKeys: string[]): ToolDefinition[] {
    const resolved: Array<{ key: string; entry: ToolEntry }> = []
    for (const keyCandidate of selectedKeys) {
      const key = keyCandidate.trim()
      if (!key) continue

      const entry = this.entries.get(key)
      if (entry) resolved.push({ key, entry })
    }

    const result: ToolDefinition[] = []
    const seen = new Set<string>()

    for (const { key, entry } of resolved) {
      const finalName = this.executionNameFor(entry)
      if (seen.has(finalName)) continue
      seen.add(finalName)
      result.push(this.aliasTool(key, entry, finalName))
    }

    return result
  }
}

let registryInstance: ToolRegistry | null = null

export function getToolRegistry(): ToolRegistry {
  if (!registryInstance) {
    registryInstance = new ToolRegistry()
  }
  return registryInstance
}
