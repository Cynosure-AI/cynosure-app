import type { AvatarConfig, AvatarShape } from '@shared/types'

const AVATAR_SHAPES: readonly AvatarShape[] = [
    'round', 'organic', 'boxy', 'capsule', 'nub', 'cloud', 'droplet', 'hexagon', 'sun', 'triangle',
]
const MAX_SEED_LENGTH = 120

export class AvatarConfigError extends Error {}

function optionalNumber(value: unknown, field: string, min: number, max: number): number | null {
    if (value === undefined || value === null) return null
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new AvatarConfigError(`avatar.${field} must be a number from ${min} to ${max}, or null`)
    }
    return value
}

/**
 * Validate a stored or submitted avatar config. Returns null when nothing is
 * customised, so "all defaults" has a single representation.
 */
export function normalizeAvatarConfig(value: unknown): AvatarConfig | null {
    if (value === undefined || value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) throw new AvatarConfigError('avatar must be an object or null')
    const input = value as Record<string, unknown>

    let seed: string | null = null
    if (input.seed !== undefined && input.seed !== null) {
        if (typeof input.seed !== 'string') throw new AvatarConfigError('avatar.seed must be a string or null')
        seed = input.seed.trim().slice(0, MAX_SEED_LENGTH) || null
    }
    let shape: AvatarShape | null = null
    if (input.shape !== undefined && input.shape !== null) {
        if (!AVATAR_SHAPES.includes(input.shape as AvatarShape)) throw new AvatarConfigError('Unknown avatar shape')
        shape = input.shape as AvatarShape
    }
    const config: AvatarConfig = {
        seed,
        hue: optionalNumber(input.hue, 'hue', 0, 360),
        tone: optionalNumber(input.tone, 'tone', 0, 1),
        shape,
    }
    return Object.values(config).every((field) => field === null) ? null : config
}

/** Parse the agents.avatar_json column, dropping anything that no longer validates. */
export function parseStoredAvatarConfig(json: string | null): AvatarConfig | null {
    if (!json) return null
    try {
        return normalizeAvatarConfig(JSON.parse(json))
    } catch {
        return null
    }
}
