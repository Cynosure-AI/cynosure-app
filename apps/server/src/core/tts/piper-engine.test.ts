import { describe, expect, test } from 'vitest'
import { encodeWav } from './piper-engine.js'

describe('encodeWav', () => {
    test('writes a 16-bit mono PCM header and clamps samples', () => {
        const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 22050)

        expect(wav.length).toBe(44 + 8)
        expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
        expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
        expect(wav.readUInt16LE(22)).toBe(1)
        expect(wav.readUInt32LE(24)).toBe(22050)
        expect(wav.readUInt32LE(40)).toBe(8)
        expect([0, 1, 2, 3].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([0, 32767, -32768, 32767])
    })
})
