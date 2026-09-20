import { describe, expect, test } from 'vitest'
import type { MemoryFolder } from '../api/types'
import {
  allMemoryFolderSelectionIds,
  isAutoExcludedMemoryFolder,
  isMemoryFolderSelected,
} from './memory-folder-selection'

function folder(id: string, folderPath: string, isUncategorized = false, autoMemoryExcluded = false): MemoryFolder {
  return {
    id,
    name: id,
    description: '',
    directoryPath: `/memory/${folderPath}`,
    folderPath,
    sortOrder: 0,
    isUncategorized,
    autoMemoryExcluded,
    createdAt: 1,
    fileCount: 0,
  }
}

describe('memory folder selection', () => {
  const folders = [
    folder('root', '', true),
    folder('notes', 'notes'),
    folder('archive', 'Archive', false, true),
    folder('archive-child', 'Archive/2024', false, true),
    folder('nested-secret', 'notes/SeCrEt', false, true),
    folder('agents', '.agents'),
  ]

  test('uses the persisted exclusion setting instead of the folder name', () => {
    expect(isAutoExcludedMemoryFolder(folders[1])).toBe(false)
    expect(isAutoExcludedMemoryFolder(folders[2])).toBe(true)
    expect(isAutoExcludedMemoryFolder(folders[4])).toBe(true)
    expect(isAutoExcludedMemoryFolder(folders[5])).toBe(false)
    expect(isAutoExcludedMemoryFolder(folder('ordinary-archive', 'Archive'))).toBe(false)
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
