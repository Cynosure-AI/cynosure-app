import { describe, expect, test } from 'vitest'
import type { MemoryFolder } from '../api/types'
import {
  AUTO_EXCLUDED_MEMORY_FOLDER_NAMES,
  allMemoryFolderSelectionIds,
  isAutoExcludedMemoryFolder,
  isMemoryFolderSelected,
} from './memory-folder-selection'

function folder(id: string, folderPath: string, isUncategorized = false): MemoryFolder {
  return {
    id,
    name: id,
    description: '',
    directoryPath: `/memory/${folderPath}`,
    folderPath,
    sortOrder: 0,
    isUncategorized,
    createdAt: 1,
    fileCount: 0,
  }
}

describe('memory folder selection', () => {
  const folders = [
    folder('root', '', true),
    folder('notes', 'notes'),
    folder('archive', 'Archive'),
    folder('archive-child', 'Archive/2024'),
    folder('nested-secret', 'notes/SeCrEt'),
    folder('agents', '.agents'),
  ]

  test('publishes the special names shown in the folder UI', () => {
    expect(AUTO_EXCLUDED_MEMORY_FOLDER_NAMES).toEqual([
      'Archive', 'Subconscious', 'Secret', 'Hidden',
    ])
  })

  test('recognizes special folder names at any depth without regard to capitalization', () => {
    expect(isAutoExcludedMemoryFolder(folders[1])).toBe(false)
    expect(isAutoExcludedMemoryFolder(folders[2])).toBe(true)
    expect(isAutoExcludedMemoryFolder(folders[4])).toBe(true)
    expect(isAutoExcludedMemoryFolder(folders[5])).toBe(false)
  })

  test('a root default selects standard folders but leaves special folders available manually', () => {
    const selected = new Set(['root'])
    expect(isMemoryFolderSelected(folders[1], selected, true)).toBe(true)
    expect(isMemoryFolderSelected(folders[2], selected, true)).toBe(false)
    selected.add('archive')
    expect(isMemoryFolderSelected(folders[2], selected, true)).toBe(true)
  })

  test('select all explicitly includes special folders', () => {
    expect(allMemoryFolderSelectionIds(folders)).toEqual([
      'root', 'archive', 'archive-child', 'nested-secret',
    ])
  })
})
