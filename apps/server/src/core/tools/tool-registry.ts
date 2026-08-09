import type { RegisteredToolDefinition, RegistryAwareToolDefinition, ToolBehaviorAnnotations, ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'
import { normalizeToolDescription } from './tool-description.js'

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

export interface ToolNamespaceMetadata extends ToolNamespace {
  toolCount: number
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
  /** Advisory behavior metadata declared by the tool provider. */
  annotations?: ToolBehaviorAnnotations
  namespace: ToolNamespace
  ambiguous: boolean
}

interface ToolEntry {
  tool: ToolDefinition
  namespace: ToolNamespace
}

interface NameResolutionScope {
  ambiguous: boolean
  entriesWithSameName: ToolEntry[]
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

  private safeSlug(value: string, fallback: string): string {
    return value
      .toLowerCase()
      .replace(/^mcp[-_\s]+/i, '')
      .replace(/^mcp:/, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      || fallback
  }

  private safeSlugForNamespace(namespace: ToolNamespace): string {
    const labelSlug = this.safeSlug(namespace.label, '')
    const idSlug = this.safeSlug(namespace.id, '')
    return labelSlug || idSlug || 'server'
  }

  private safeIdSlugForNamespace(namespace: ToolNamespace): string {
    return this.safeSlug(namespace.id, 'ns')
  }

  private executionNameFor(entry: ToolEntry, scope?: NameResolutionScope): string {
    const globalKeys = this.nameIndex.get(entry.tool.name)
    const globalAmbiguous = (globalKeys?.size ?? 0) > 1
    const ambiguous = scope?.ambiguous ?? globalAmbiguous
    if (!ambiguous) return entry.tool.name

    const sameNameEntries = scope?.entriesWithSameName
      ?? [...(globalKeys || [])]
        .map((key) => this.entries.get(key))
        .filter((item): item is ToolEntry => Boolean(item))

    // Derive a human-readable namespace prefix and disambiguate that prefix
    // itself if two namespaces would otherwise generate the same slug.
    const baseSlug = this.safeSlugForNamespace(entry.namespace)
    const sameSlugCollision = sameNameEntries
      .some((other) => other.namespace.id !== entry.namespace.id && this.safeSlugForNamespace(other.namespace) === baseSlug)
    const uniqueSlug = sameSlugCollision
      ? `${baseSlug}_${this.safeIdSlugForNamespace(entry.namespace).slice(0, 8)}`
      : baseSlug

    return `${uniqueSlug}__${entry.tool.name}`
  }

  private deriveNamespaceDescription(namespace: ToolNamespace, tools: ToolDefinition[]): string | undefined {
    if (namespace.description?.trim()) return namespace.description.trim()

    const samples = tools
      .slice(0, 8)
      .map((tool) => `${tool.name}: ${normalizeToolDescription(tool.description)}`)
      .join('\n')
      .trim()

    return samples || undefined
  }

  private aliasTool(key: string, entry: ToolEntry, executionName: string): RegisteredToolDefinition {
    const metadata = {
      registryKey: key,
      originalName: entry.tool.name,
      namespaceId: entry.namespace.id,
      namespaceLabel: entry.namespace.label,
      namespaceDescription: entry.namespace.description,
    }
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

  getNamespaceMetadataForTools(tools: RegistryAwareToolDefinition[]): ToolNamespaceMetadata[] {
    const groups = new Map<string, { namespace: ToolNamespace; tools: ToolDefinition[] }>()

    for (const tool of tools) {
      let namespace: ToolNamespace | undefined
      if (tool.registryKey) {
        namespace = this.entries.get(tool.registryKey)?.namespace
      }
      if (!namespace && tool.namespaceId) {
        namespace = {
          id: tool.namespaceId,
          label: tool.namespaceLabel || tool.namespaceId,
          description: tool.namespaceDescription,
        }
      }
      if (!namespace) continue

      const group = groups.get(namespace.id)
      if (group) {
        group.tools.push(tool)
      } else {
        groups.set(namespace.id, { namespace, tools: [tool] })
      }
    }

    return [...groups.values()].map(({ namespace, tools: namespaceTools }) => ({
      id: namespace.id,
      label: namespace.label,
      description: this.deriveNamespaceDescription(namespace, namespaceTools),
      toolCount: namespaceTools.length,
    }))
  }

  listRegisteredTools(): RegisteredToolInfo[] {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      name: entry.tool.name,
      executionName: this.executionNameFor(entry),
      description: entry.tool.description,
      parameters: entry.tool.parameters,
      annotations: entry.tool.annotations,
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

  getToolDefinitions(): RegisteredToolDefinition[] {
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
  resolveForExecution(selectedKeys: string[]): RegisteredToolDefinition[] {
    const resolved: Array<{ key: string; entry: ToolEntry }> = []
    for (const keyCandidate of selectedKeys) {
      const key = keyCandidate.trim()
      if (!key) continue

      const entry = this.entries.get(key)
      if (entry) resolved.push({ key, entry })
    }

    const result: RegisteredToolDefinition[] = []
    const seen = new Set<string>()
    const selectedByBareName = new Map<string, ToolEntry[]>()

    for (const { entry } of resolved) {
      const bare = entry.tool.name
      const bucket = selectedByBareName.get(bare)
      if (bucket) bucket.push(entry)
      else selectedByBareName.set(bare, [entry])
    }

    for (const { key, entry } of resolved) {
      const sameNameEntries = selectedByBareName.get(entry.tool.name) || [entry]
      const finalName = this.executionNameFor(entry, {
        ambiguous: sameNameEntries.length > 1,
        entriesWithSameName: sameNameEntries,
      })
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
