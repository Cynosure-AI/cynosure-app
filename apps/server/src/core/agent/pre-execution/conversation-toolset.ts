import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'

/** Past this many routed tools, start over from the current routing result. */
export const MAX_STICKY_TOOLS = 48
const MAX_TRACKED_TOOLSETS = 500

const offeredToolNames = new Map<string, string[]>()

/**
 * Keep the routed tool list append-only across a conversation's turns.
 *
 * Tool definitions lead every provider request, so any change to the list
 * invalidates the whole prompt cache. Re-offering earlier tools in their
 * earlier order keeps the cache valid until routing needs something new,
 * which is then appended. Tools that left the candidate catalogue are dropped.
 */
export function stabilizeRoutedTools(
    key: string,
    routed: RegistryAwareToolDefinition[],
    candidates: RegistryAwareToolDefinition[],
): RegistryAwareToolDefinition[] {
    const byName = new Map<string, RegistryAwareToolDefinition>()
    for (const tool of candidates) byName.set(tool.name, tool)
    // Routed definitions win: routing builds some tools (e.g. tool search) per turn.
    for (const tool of routed) byName.set(tool.name, tool)

    const kept = (offeredToolNames.get(key) ?? []).flatMap((name) => {
        const tool = byName.get(name)
        return tool ? [tool] : []
    })
    const keptNames = new Set(kept.map((tool) => tool.name))
    const added = routed.filter((tool) => !keptNames.has(tool.name))
    const tools = kept.length + added.length > MAX_STICKY_TOOLS ? routed : [...kept, ...added]

    offeredToolNames.delete(key)
    offeredToolNames.set(key, tools.map((tool) => tool.name))
    if (offeredToolNames.size > MAX_TRACKED_TOOLSETS) {
        offeredToolNames.delete(offeredToolNames.keys().next().value!)
    }
    return tools
}

export function resetStickyToolsets(): void {
    offeredToolNames.clear()
}
