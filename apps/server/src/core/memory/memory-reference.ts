import { createHash } from 'node:crypto'

const STABLE_SUFFIX_LENGTH = 6
const STABLE_SUFFIX_SPACE = 36n ** BigInt(STABLE_SUFFIX_LENGTH)
const STABLE_REFERENCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?#[a-z0-9]{6}$/

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

/** Normalize a model-supplied reference, or return `undefined` when it is not a stable ref. */
export function parseMemoryDocumentRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return STABLE_REFERENCE_PATTERN.test(trimmed) ? trimmed : undefined
}
