import type { ToolResultContent } from '../../gateway/providers/base.provider.js'

interface McpCallToolResultLike {
    content?: unknown
    structuredContent?: unknown
    isError?: boolean
    _meta?: Record<string, unknown>
}

export interface NormalizedMcpToolResult {
    output: string
    content?: ToolResultContent[]
    structuredContent?: unknown
    providerMetadata?: Record<string, unknown>
    imageDataUrls?: string[]
    audioDataUrls?: string[]
}

/**
 * Convert an MCP result into a single model-facing representation while
 * retaining the original structured/rich values for non-model consumers.
 */
export function normalizeMcpToolResult(result: McpCallToolResultLike): NormalizedMcpToolResult {
    const content = Array.isArray(result.content)
        ? result.content.filter(isToolResultContent)
        : []
    const hasStructuredContent = Object.prototype.hasOwnProperty.call(result, 'structuredContent')
        && result.structuredContent !== undefined
    const textParts: string[] = []
    const supplementalParts: string[] = []
    let omittedStructuredDuplicate = false
    const imageDataUrls: string[] = []
    const audioDataUrls: string[] = []

    for (const block of content) {
        switch (block.type) {
            case 'text': {
                const text = block.text.trim()
                if (!text) break
                if (hasStructuredContent && textRepresentsJsonValue(text, result.structuredContent)) {
                    omittedStructuredDuplicate = true
                } else {
                    textParts.push(text)
                }
                break
            }
            case 'image':
                imageDataUrls.push(`data:${block.mimeType};base64,${block.data}`)
                break
            case 'audio':
                audioDataUrls.push(`data:${block.mimeType};base64,${block.data}`)
                break
            case 'resource_link':
                supplementalParts.push(formatResourceLink(block))
                break
            case 'resource':
                supplementalParts.push(formatEmbeddedResource(block))
                if (block.resource.blob && block.resource.mimeType?.startsWith('image/')) {
                    imageDataUrls.push(`data:${block.resource.mimeType};base64,${block.resource.blob}`)
                } else if (block.resource.blob && block.resource.mimeType?.startsWith('audio/')) {
                    audioDataUrls.push(`data:${block.resource.mimeType};base64,${block.resource.blob}`)
                }
                break
        }
    }

    const outputParts = [...textParts, ...supplementalParts]
    if (hasStructuredContent) {
        const serialized = stringifyJson(result.structuredContent)
        // A backwards-compatible JSON TextContent block and structuredContent
        // represent the same value. Emit that value only once. A distinct human
        // summary is retained alongside the structured data.
        if (outputParts.length) {
            outputParts.push(`Structured content:\n${serialized}`)
        } else if (omittedStructuredDuplicate || serialized) {
            outputParts.push(serialized)
        }
    }

    const mediaCount = imageDataUrls.length + audioDataUrls.length
    const output = outputParts.join('\n\n')
        || (mediaCount ? `(${mediaCount} media item${mediaCount === 1 ? '' : 's'} returned)` : '(no output)')

    return {
        output,
        content: content.length ? content : undefined,
        structuredContent: hasStructuredContent ? result.structuredContent : undefined,
        providerMetadata: result._meta,
        imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined,
        audioDataUrls: audioDataUrls.length ? audioDataUrls : undefined,
    }
}

function isToolResultContent(value: unknown): value is ToolResultContent {
    if (!value || typeof value !== 'object') return false
    const block = value as Record<string, unknown>
    if (block.type === 'text') return typeof block.text === 'string'
    if (block.type === 'image' || block.type === 'audio') {
        return typeof block.data === 'string' && typeof block.mimeType === 'string'
    }
    if (block.type === 'resource_link') {
        return typeof block.uri === 'string' && typeof block.name === 'string'
    }
    if (block.type === 'resource') {
        return Boolean(block.resource && typeof block.resource === 'object'
            && typeof (block.resource as Record<string, unknown>).uri === 'string')
    }
    return false
}

function textRepresentsJsonValue(text: string, structuredContent: unknown): boolean {
    const candidate = unwrapJsonFence(text)
    try {
        return jsonValuesEqual(JSON.parse(candidate), structuredContent)
    } catch {
        return false
    }
}

function unwrapJsonFence(text: string): string {
    const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    return match?.[1] ?? text
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
    return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        return `{${entries.join(',')}}`
    }
    return JSON.stringify(value)
}

function stringifyJson(value: unknown): string {
    const serialized = JSON.stringify(value, null, 2)
    return serialized === undefined ? String(value) : serialized
}

function formatResourceLink(block: Extract<ToolResultContent, { type: 'resource_link' }>): string {
    const label = block.title || block.name || block.uri
    const details = [block.description, block.mimeType].filter(Boolean).join(' — ')
    return `[Resource: ${label}](${block.uri})${details ? `\n${details}` : ''}`
}

function formatEmbeddedResource(block: Extract<ToolResultContent, { type: 'resource' }>): string {
    const resource = block.resource
    const header = `[Embedded resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''}]`
    if (typeof resource.text === 'string') return `${header}\n${resource.text}`
    if (typeof resource.blob === 'string') return `${header}\n[Binary data: ${resource.blob.length} base64 characters]`
    return header
}
