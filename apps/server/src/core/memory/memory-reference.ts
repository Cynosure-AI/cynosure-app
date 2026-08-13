const MODEL_REFERENCE_LENGTH = 12

export interface ParsedMemoryDocumentRef {
  documentIdPrefix: string
  contentHashPrefix: string
}

/**
 * Opaque model-facing handle for one document at the state in which it was read.
 * The model only needs to pass this value back; identity and freshness stay a
 * server concern.
 */
export function formatMemoryDocumentRef(documentId: string, contentHash: string): string {
  return `m:${documentId.slice(0, MODEL_REFERENCE_LENGTH)}.${contentHash.slice(0, MODEL_REFERENCE_LENGTH)}`
}

export function parseMemoryDocumentRef(value: unknown): ParsedMemoryDocumentRef | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^m:([a-f0-9]{12})\.([a-f0-9]{12})$/i.exec(value.trim())
  if (!match) return undefined
  return {
    documentIdPrefix: match[1].toLowerCase(),
    contentHashPrefix: match[2].toLowerCase(),
  }
}

export function memoryDocumentRefMatchesContentHash(ref: ParsedMemoryDocumentRef, contentHash: string): boolean {
  return contentHash.toLowerCase().startsWith(ref.contentHashPrefix)
}
