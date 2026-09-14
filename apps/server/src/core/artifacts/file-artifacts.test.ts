import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { materializeFileAttachment } from './file-artifacts.js'

describe('file attachments', () => {
    const previousDataDir = process.env.CYNOSURE_DATA_DIR
    let rootDir: string

    beforeAll(() => {
        rootDir = mkdtempSync(join(tmpdir(), 'cynosure-file-artifacts-'))
        process.env.CYNOSURE_DATA_DIR = rootDir
    })

    afterAll(() => {
        if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR
        else process.env.CYNOSURE_DATA_DIR = previousDataDir
        rmSync(rootDir, { recursive: true, force: true })
    })

    test('copies uploaded content and parsed text into canonical attachment storage', async () => {
        const attachment = await materializeFileAttachment({
            name: 'notes.txt',
            content: `data:text/plain;base64,${Buffer.from('durable notes').toString('base64')}`,
        }, 'conversation-files')

        expect(attachment.originalPath).toContain(join('artifacts', 'attachment-assets'))
        expect(existsSync(attachment.originalPath)).toBe(true)
        expect(existsSync(attachment.textPath)).toBe(true)
        expect(readFileSync(attachment.originalPath).toString()).toBe('durable notes')
        expect(readFileSync(attachment.textPath).toString()).toBe('durable notes')
    })
})
