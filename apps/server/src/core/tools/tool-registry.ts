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
}

interface ToolEntry {
  tool: ToolDefinition
  namespace: ToolNamespace
}

/**
 * Global tool registry that supports multiple tools with the same bare name
 * from different namespaces. Tools are stored by composite key (namespace::name)
 * and indexed by bare name for quick lookup.
 *
 * When a bare name is unique across all namespaces, `get(name)` returns it
 * directly. When ambiguous, callers must use a qualified key or the
 * `resolveForExecution()` method to pick the right one.
 */
export class ToolRegistry {
  /** Primary storage: compositeKey → entry */
  private entries = new Map<string, ToolEntry>()
  /** Index: bareName → Set<compositeKey> */
  private nameIndex = new Map<string, Set<string>>()

  private compositeKey(namespace: ToolNamespace, toolName: string): string {
    return `${namespace.id}::${toolName}`
  }

  register(tool: ToolDefinition, namespace: ToolNamespace = { id: 'unknown', label: 'Unknown' }): void {
    const key = this.compositeKey(namespace, tool.name)
    this.entries.set(key, { tool, namespace })

    if (!this.nameIndex.has(tool.name)) {
      this.nameIndex.set(tool.name, new Set())
    }
    this.nameIndex.get(tool.name)!.add(key)
  }

  unregister(name: string): void {
    // Remove all entries matching this bare name
    const keys = this.nameIndex.get(name)
    if (keys) {
      for (const key of keys) this.entries.delete(key)
      this.nameIndex.delete(name)
    }
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

  /**
   * Get a tool by bare name (when unique) or composite key.
   * Returns undefined if the bare name is ambiguous — use resolveForExecution() instead.
   */
  get(name: string): ToolDefinition | undefined {
    // Try as composite key first
    const direct = this.entries.get(name)
    if (direct) return direct.tool

    // Try as bare name
    const keys = this.nameIndex.get(name)
    if (!keys || keys.size === 0) return undefined
    if (keys.size === 1) return this.entries.get([...keys][0])!.tool

    // Ambiguous — multiple tools share this bare name.
    // Fall back: return the built-in one if present, otherwise first.
    for (const key of keys) {
      if (key.startsWith('builtin::')) return this.entries.get(key)!.tool
    }
    return this.entries.get([...keys][0])!.tool
  }

  getNamespace(name: string): ToolNamespace | undefined {
    // Try composite key
    const direct = this.entries.get(name)
    if (direct) return direct.namespace

    // Bare name
    const keys = this.nameIndex.get(name)
    if (!keys || keys.size === 0) return undefined
    if (keys.size === 1) return this.entries.get([...keys][0])!.namespace
    // Ambiguous: prefer built-in
    for (const key of keys) {
      if (key.startsWith('builtin::')) return this.entries.get(key)!.namespace
    }
    return this.entries.get([...keys][0])!.namespace
  }

  getAll(): ToolDefinition[] {
    return [...this.entries.values()].map(e => e.tool)
  }

  getAllWithNamespaces(): { tool: ToolDefinition; namespace: ToolNamespace }[] {
    return [...this.entries.values()].map(({ tool, namespace }) => ({ tool, namespace }))
  }

  getToolSchemas(): LLMToolSchema[] {
    return this.getAll().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }))
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.getAll()
  }

  has(name: string): boolean {
    return this.entries.has(name) || (this.nameIndex.get(name)?.size ?? 0) > 0
  }

  async execute(name: string, params: unknown): Promise<ToolResult> {
    const tool = this.get(name)
    if (!tool) {
      return { success: false, output: '', error: `Tool '${name}' not found` }
    }
    return tool.execute(params)
  }

  /**
   * Look up the MCP slug for a given namespace ID.
   * Used by resolveForExecution to build collision prefixes.
   */
  getSlugForNamespace(namespaceId: string): string {
    // namespace id format: "mcp:<serverId>" — derive slug from label
    for (const entry of this.entries.values()) {
      if (entry.namespace.id === namespaceId) {
        return entry.namespace.label
          .toLowerCase()
          .replace(/^mcp[-_\s]+/i, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
          || 'server'
      }
    }
    return 'server'
  }

  /**
   * Resolve a list of tool names into ToolDefinitions ready for LLM injection.
   * - Bare names that are unique → returned as-is.
   * - Bare names that collide among the selected set → ALL tools from each
   *   colliding MCP namespace get a `slug__` prefix.
   *
   * This is the method all execution paths should use instead of manual
   * get() + filter().
   */
  resolveForExecution(selectedNames: string[]): ToolDefinition[] {
    // ── Pre-pass: collect "active" namespaces from unambiguous selections ──
    // When a bare name is ambiguous in the global registry (exists in 2+ MCP
    // namespaces), we must not blindly include tools from namespaces the user
    // never selected. We only include a namespace in the ambiguous expansion if
    // at least one OTHER tool from that namespace was unambiguously selected.
    const activeNamespaces = new Set<string>()
    for (const name of selectedNames) {
      const direct = this.entries.get(name)
      if (direct) { activeNamespaces.add(direct.namespace.id); continue }
      const keys = this.nameIndex.get(name)
      if (keys?.size === 1) {
        activeNamespaces.add(this.entries.get([...keys][0])!.namespace.id)
      }
    }

    // Phase 1: Resolve each name to its ToolEntry(ies)
    const resolved: { name: string; entry: ToolEntry }[] = []
    for (const name of selectedNames) {
      // Composite key?
      const direct = this.entries.get(name)
      if (direct) {
        resolved.push({ name: direct.tool.name, entry: direct })
        continue
      }
      // Bare name
      const keys = this.nameIndex.get(name)
      if (keys && keys.size > 0) {
        if (keys.size === 1) {
          const entry = this.entries.get([...keys][0])!
          resolved.push({ name, entry })
        } else {
          // Ambiguous bare name — only include tools from namespaces that are
          // already active (i.e. had at least one unambiguous tool selected).
          // This prevents unintended injection of tools from MCPs not in the
          // user's selection when a tool name happens to collide globally.
          const activeMatches = [...keys]
            .map(k => this.entries.get(k)!)
            .filter(e => activeNamespaces.has(e.namespace.id))
          if (activeMatches.length > 0) {
            for (const entry of activeMatches) resolved.push({ name, entry })
          } else {
            // Fallback: none of the matching namespaces has other active tools
            // (e.g. only ambiguous tools were selected). Prefer built-in; otherwise
            // first registered — consistent with get() behaviour.
            const builtinKey = [...keys].find(k => k.startsWith('builtin::'))
            const fallbackKey = builtinKey || [...keys][0]
            resolved.push({ name, entry: this.entries.get(fallbackKey)! })
          }
        }
        continue
      }
      // Legacy slug__name format (from before the registry rework)
      const idx = name.indexOf('__')
      if (idx > 0) {
        const bare = name.slice(idx + 2)
        const bareKeys = this.nameIndex.get(bare)
        if (bareKeys && bareKeys.size > 0) {
          const entry = this.entries.get([...bareKeys][0])!
          resolved.push({ name: bare, entry })
        }
      }
    }

    // Phase 2: Detect collisions (same bare name, different namespaces)
    const bareGroups = new Map<string, Set<string>>() // bareName → set of namespace IDs
    for (const { name, entry } of resolved) {
      if (!bareGroups.has(name)) bareGroups.set(name, new Set())
      bareGroups.get(name)!.add(entry.namespace.id)
    }

    // Namespaces that need prefixing (have at least one colliding tool)
    const prefixNamespaces = new Set<string>()
    for (const [, nsIds] of bareGroups) {
      if (nsIds.size > 1) {
        for (const nsId of nsIds) prefixNamespaces.add(nsId)
      }
    }

    // Phase 3: Build final tool list with clean or prefixed names
    const slugCache = new Map<string, string>()
    const seen = new Set<string>()
    const result: ToolDefinition[] = []

    for (const { entry } of resolved) {
      const tool = entry.tool
      let finalName = tool.name

      if (prefixNamespaces.has(entry.namespace.id)) {
        if (!slugCache.has(entry.namespace.id)) {
          slugCache.set(entry.namespace.id, this.getSlugForNamespace(entry.namespace.id))
        }
        finalName = `${slugCache.get(entry.namespace.id)}__${tool.name}`
      }

      // Deduplicate (same tool resolved from multiple paths)
      if (seen.has(finalName)) continue
      seen.add(finalName)

      result.push(finalName === tool.name ? tool : { ...tool, name: finalName })
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
