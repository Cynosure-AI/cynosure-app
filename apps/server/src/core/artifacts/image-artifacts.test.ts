import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
    artifactFileUrlToDataUrl,
    extractFilePathFromFileUrl,
    materializeAudioArtifacts,
    materializeImageArtifact,
    materializeMediaBuffer,
    materializeVideoArtifacts,
} from './image-artifacts.js'

describe('conversation media artifacts', () => {
    const previousDataDir = process.env.CYNOSURE_DATA_DIR
    let rootDir: string

    beforeAll(() => {
        rootDir = mkdtempSync(join(tmpdir(), 'cynosure-media-artifacts-'))
        process.env.CYNOSURE_DATA_DIR = rootDir
    })

    afterAll(() => {
        if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR
        else process.env.CYNOSURE_DATA_DIR = previousDataDir
        rmSync(rootDir, { recursive: true, force: true })
    })

    test('materializes image and audio data URLs into conversation-scoped files', async () => {
        const image = await materializeImageArtifact(
            `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
            'conversation-a',
        )
        const [audio] = await materializeAudioArtifacts([
            `data:audio/mpeg;base64,${Buffer.from('audio-bytes').toString('base64')}`,
        ], 'conversation-a')

        expect(image.path).toContain(join('artifacts', 'conversations', 'conversation-a', 'images'))
        expect(audio.path).toContain(join('artifacts', 'conversations', 'conversation-a', 'audio'))
        expect(readFileSync(image.path).toString()).toBe('image-bytes')
        expect(readFileSync(audio.path).toString()).toBe('audio-bytes')
        expect(artifactFileUrlToDataUrl(audio.url)).toBe(
            `data:audio/mpeg;base64,${Buffer.from('audio-bytes').toString('base64')}`,
        )
    })

    test('writes generated video bytes locally and copies them when a conversation is forked', async () => {
        const video = materializeMediaBuffer(
            Buffer.from('video-bytes'),
            'video/webm',
            'conversation-a',
            'video',
        )
        const [forked] = await materializeVideoArtifacts([video.url], 'conversation-b')

        expect(video.path).toContain(join('artifacts', 'conversations', 'conversation-a', 'videos'))
        expect(video.path.endsWith('.webm')).toBe(true)
        expect(forked.path).toContain(join('artifacts', 'conversations', 'conversation-b', 'videos'))
        expect(forked.path).not.toBe(video.path)
        expect(existsSync(forked.path)).toBe(true)
        expect(readFileSync(forked.path).toString()).toBe('video-bytes')
        expect(extractFilePathFromFileUrl(forked.url)).toBe(forked.path)
    })
})
