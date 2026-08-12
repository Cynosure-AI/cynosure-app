import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import { archiveFile } from './memory-file-manager.js'

describe('archiveFile', () => {
    const temporaryFolders: string[] = []

    afterEach(() => {
        for (const folderPath of temporaryFolders.splice(0)) {
            rmSync(folderPath, { recursive: true, force: true })
        }
    })

    test('moves a removed source into hidden trash', () => {
        const folderPath = mkdtempSync(join(tmpdir(), 'cynosure-memory-'))
        temporaryFolders.push(folderPath)
        writeFileSync(join(folderPath, 'notes.md'), 'authoritative content', 'utf-8')

        const archivedPath = archiveFile(folderPath, 'notes.md')

        expect(archivedPath).toContain(join(folderPath, '.trash'))
        expect(readFileSync(archivedPath!, 'utf-8')).toBe('authoritative content')
        expect(() => readFileSync(join(folderPath, 'notes.md'), 'utf-8')).toThrow()
    })

    test('does not allow a path outside the memory folder', () => {
        const folderPath = mkdtempSync(join(tmpdir(), 'cynosure-memory-'))
        temporaryFolders.push(folderPath)
        expect(() => archiveFile(folderPath, '../notes.md')).toThrow('Invalid memory file name')
    })
})
