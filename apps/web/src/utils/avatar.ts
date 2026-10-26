import type { AvatarConfig, AvatarShape, AvatarSource } from '@shared/types'
import { traits, type TraitOverrides } from 'blobatar'
import { blobatarUri } from 'blobatar/uri'

export type { AvatarConfig, AvatarShape, AvatarSource }

/**
 * Each silhouette's position in blobatar's shape trait: the middle of its band,
 * so a pinned shape never sits on a band edge. The bands are frozen per blobatar
 * major (gen2: round < 0.22 < organic < 0.48 < boxy < 0.6 < capsule < 0.7 < nub
 * < 0.79 < cloud < 0.86 < droplet < 0.915 < hexagon < 0.95 < sun < 0.98 < triangle).
 */
export const AVATAR_SHAPES: ReadonlyArray<{ shape: AvatarShape; label: string; position: number }> = [
  { shape: 'round', label: 'Round', position: 0.11 },
  { shape: 'organic', label: 'Pebble', position: 0.35 },
  { shape: 'boxy', label: 'Boxy', position: 0.54 },
  { shape: 'capsule', label: 'Capsule', position: 0.65 },
  { shape: 'nub', label: 'Nub', position: 0.745 },
  { shape: 'cloud', label: 'Cloud', position: 0.825 },
  { shape: 'droplet', label: 'Droplet', position: 0.8875 },
  { shape: 'hexagon', label: 'Hexagon', position: 0.9325 },
  { shape: 'sun', label: 'Sun', position: 0.965 },
  { shape: 'triangle', label: 'Triangle', position: 0.99 },
]

const SHAPE_POSITIONS = new Map(AVATAR_SHAPES.map((entry) => [entry.shape, entry.position]))

/**
 * Silhouettes a name never lands on by itself (nub and sun read poorly as faces);
 * they stay available as a manual pick. Bands as in AVATAR_SHAPES, [start, end).
 */
const UNSEEDED_BANDS: ReadonlyArray<[number, number]> = [[0.7, 0.79], [0.95, 0.98]]
const SEEDED_POSITIONS = AVATAR_SHAPES
  .filter(({ shape }) => shape !== 'nub' && shape !== 'sun')
  .map(({ position }) => position)

/**
 * The shape position a name gets on its own. Every other name keeps the exact
 * silhouette blobatar hashes it to; one that hashes into an excluded band is
 * moved, by where it fell inside that band, onto one of the remaining shapes.
 */
export function seededShapePosition(seed: string): number | undefined {
  const position = traits(seed)('shape')
  const band = UNSEEDED_BANDS.find(([start, end]) => position >= start && position < end)
  if (!band) return undefined
  const fraction = (position - band[0]) / (band[1] - band[0])
  return SEEDED_POSITIONS[Math.min(SEEDED_POSITIONS.length - 1, Math.floor(fraction * SEEDED_POSITIONS.length))]
}

/** The props `<Blobatar>` needs for an assistant with this name and config. */
export function blobatarProps(name: string, config: AvatarConfig | null | undefined): {
  name: string
  hue?: number
  tone?: number
  traits?: TraitOverrides
} {
  const seed = config?.seed || name || 'assistant'
  const shape = config?.shape ? SHAPE_POSITIONS.get(config.shape) : seededShapePosition(seed)
  return {
    name: seed,
    hue: config?.hue ?? undefined,
    // An exact 1 wraps to the palest swatch; 0.999 is the ink end.
    tone: config?.tone == null ? undefined : Math.min(config.tone, 0.999),
    traits: shape === undefined ? undefined : { shape },
  }
}

/**
 * Blobatar's six authored color schemes, frozen per major. `tone` is a 0–1
 * position, but it only ever selects one of these bands; positions are mids.
 */
export const AVATAR_TONES = [
  { tone: 'pastel', label: 'Pastel', end: 0.2, position: 0.1 },
  { tone: 'pale', label: 'Pale', end: 0.36, position: 0.28 },
  { tone: 'mid', label: 'Mid', end: 0.62, position: 0.49 },
  { tone: 'deep', label: 'Deep', end: 0.8, position: 0.71 },
  { tone: 'bright', label: 'Bright', end: 0.93, position: 0.865 },
  { tone: 'ink', label: 'Ink', end: 1, position: 0.965 },
] as const

export type AvatarTone = typeof AVATAR_TONES[number]['tone']

/** Which scheme a stored tone position falls in. */
export function toneAt(position: number): AvatarTone {
  return (AVATAR_TONES.find((entry) => position < entry.end) ?? AVATAR_TONES[0]).tone
}

/** Collapse a config with nothing customised to null, the server's "default face". */
export function compactAvatarConfig(config: AvatarConfig): AvatarConfig | null {
  return Object.values(config).every((value) => value === null || value === '') ? null : config
}

export const EMPTY_AVATAR_CONFIG: AvatarConfig = { seed: null, hue: null, tone: null, shape: null }

/** The image an assistant shows: its retained image when that is the chosen face, else null for the generated avatar. */
export function displayedIconUrl(source: AvatarSource | undefined, imageUrl: string | null | undefined): string | null {
  return source === 'image' ? imageUrl ?? null : null
}

/** An image URL for places that only take one: the uploaded icon, else the generated face. */
export function agentAvatarSrc(name: string, iconUrl: string | null | undefined, config: AvatarConfig | null | undefined): string {
  if (iconUrl) return iconUrl
  const { name: seed, ...options } = blobatarProps(name, config)
  return blobatarUri(seed, options)
}
