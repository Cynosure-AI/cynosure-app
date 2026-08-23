import { createHash } from 'node:crypto'

const LEGACY_REFERENCE_LENGTH = 12
const STABLE_SUFFIX_LENGTH = 6
const STABLE_SUFFIX_SPACE = 36n ** BigInt(STABLE_SUFFIX_LENGTH)

export type ParsedMemoryDocumentRef =
  | { kind: 'stable'; value: string }
  | { kind: 'legacy'; documentIdPrefix: string; contentHashPrefix: string }

/**
 * Build the immutable, model-facing reference assigned when a document is
 * first indexed. Callers persist the result and retry with a different
 * collisionAttempt if the six-character suffix is already in use.
 */
export function createStableMemoryDocumentRef(
  fileName: string,
  documentId: string,
  createdAt: number,
  collisionAttempt = 0,
): string {
  const stem = fileName.replace(/\.[^.]+$/, '')
  const normalizedName = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') || 'memory'
  const digest = createHash('sha256')
    .update(`${documentId}:${createdAt}:${collisionAttempt}`)
    .digest()
  const suffixNumber = digest.readBigUInt64BE(0) % STABLE_SUFFIX_SPACE
  const suffix = suffixNumber.toString(36).padStart(STABLE_SUFFIX_LENGTH, '0')
  return `${normalizedName}#${suffix}`
}

/** Legacy state-bearing ref, retained so in-flight conversations keep working. */
export function formatLegacyMemoryDocumentRef(documentId: string, contentHash: string): string {
  return `m:${documentId.slice(0, LEGACY_REFERENCE_LENGTH)}.${contentHash.slice(0, LEGACY_REFERENCE_LENGTH)}`
}

export function parseMemoryDocumentRef(value: unknown): ParsedMemoryDocumentRef | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (/^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?#[a-z0-9]{6}$/.test(trimmed)) {
    return { kind: 'stable', value: trimmed }
  }
  const match = /^m:([a-f0-9]{12})\.([a-f0-9]{12})$/.exec(trimmed)
  if (!match) return undefined
  return {
    kind: 'legacy',
    documentIdPrefix: match[1].toLowerCase(),
    contentHashPrefix: match[2].toLowerCase(),
  }
}

export function memoryDocumentRefMatchesContentHash(ref: ParsedMemoryDocumentRef, contentHash: string): boolean {
  return ref.kind === 'stable' || contentHash.toLowerCase().startsWith(ref.contentHashPrefix)
}
