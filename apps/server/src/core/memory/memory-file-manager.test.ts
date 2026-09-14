import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import { archiveFile } from './memory-file-manager.js'

describe('archiveFile', () => {
    const temporaryFolders: string[] = []

    afterEach(() => {
        for (const directoryPath of temporaryFolders.splice(0)) {
            rmSync(directoryPath, { recursive: true, force: true })
        }
    })

    test('moves a removed source into hidden trash', () => {
        const directoryPath = mkdtempSync(join(tmpdir(), 'cynosure-memory-'))
        temporaryFolders.push(directoryPath)
        writeFileSync(join(directoryPath, 'notes.md'), 'authoritative content', 'utf-8')

        const archivedPath = archiveFile(directoryPath, 'notes.md')

        expect(archivedPath).toContain(join(directoryPath, '.trash'))
        expect(readFileSync(archivedPath!, 'utf-8')).toBe('authoritative content')
        expect(() => readFileSync(join(directoryPath, 'notes.md'), 'utf-8')).toThrow()
    })

    test('does not allow a path outside the memory folder', () => {
        const directoryPath = mkdtempSync(join(tmpdir(), 'cynosure-memory-'))
        temporaryFolders.push(directoryPath)
        expect(() => archiveFile(directoryPath, '../notes.md')).toThrow('Invalid memory file name')
    })
})
