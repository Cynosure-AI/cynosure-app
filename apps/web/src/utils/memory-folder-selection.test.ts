import { describe, expect, test } from 'vitest'
import type { MemoryFolder } from '../api/types'
import {
  allMemoryDescription,
  allMemoryFolderSelectionIds,
  effectiveMemoryFolders,
  isAutoExcludedMemoryFolder,
  memoryFolderScopeSummary,
  memoryFolderSelectionInfo,
  normalizeMemoryFolderSelection,
  toggleMemoryFolderSelection,
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

const folders = [
  folder('root', '', true),
  folder('notes', 'notes'),
  folder('archive', 'Archive', false, true),
  folder('archive-child', 'Archive/2024', false, true),
  folder('archive-open', 'Archive/open'),
  folder('nested-secret', 'notes/SeCrEt', false, true),
  folder('projects', 'Projects'),
  folder('projects-a', 'Projects/A'),
  folder('projects-b', 'Projects/B'),
  folder('projects-ab', 'Projects/A/B'),
  folder('projects-ab-sibling', 'Projects/AB'),
]
const byId = (id: string) => folders.find((item) => item.id === id)!
const effectiveIds = (ids: string[]) => effectiveMemoryFolders(folders, ids).map((item) => item.id)
const state = (id: string, ids: string[]) => memoryFolderSelectionInfo(byId(id), folders, ids).state

describe('memory folder selection', () => {
  test('uses the persisted exclusion setting instead of the folder name', () => {
    expect(isAutoExcludedMemoryFolder(byId('notes'))).toBe(false)
    expect(isAutoExcludedMemoryFolder(byId('archive'))).toBe(true)
    expect(isAutoExcludedMemoryFolder(folder('ordinary-archive', 'Archive'))).toBe(false)
  })

  test('the root covers every folder that is not opt-in, like the server', () => {
    expect(effectiveIds(['root'])).toEqual([
      'root', 'notes', 'archive-open', 'projects', 'projects-a', 'projects-b', 'projects-ab', 'projects-ab-sibling',
    ])
    expect(state('notes', ['root'])).toBe('inherited')
    expect(memoryFolderSelectionInfo(byId('notes'), folders, ['root']).via?.id).toBe('root')
    expect(state('archive-child', ['root'])).toBe('none')
    // Opt-in is per folder: a regular child of an opt-in folder stays in All Memory.
    expect(state('archive-open', ['root'])).toBe('inherited')
    expect(state('archive', ['root'])).toBe('partial')
  })

  test('a folder grant covers all descendants, including opt-in ones, but not path-prefix siblings', () => {
    expect(effectiveIds(['projects-a'])).toEqual(['projects-a', 'projects-ab'])
    expect(effectiveIds(['archive'])).toEqual(['archive', 'archive-child', 'archive-open'])
    expect(effectiveIds(['notes'])).toEqual(['notes', 'nested-secret'])
  })

  test('descendants of a granted folder are inherited and cannot be unchecked on their own', () => {
    const ids = ['projects']
    expect(state('projects-b', ids)).toBe('inherited')
    expect(memoryFolderSelectionInfo(byId('projects-ab'), folders, ids).via?.id).toBe('projects')
    expect(toggleMemoryFolderSelection(byId('projects-b'), folders, ids)).toEqual(ids)
  })

  test('a redundant legacy child grant still shows as inherited', () => {
    expect(state('projects-a', ['projects', 'projects-a'])).toBe('inherited')
  })

  test('checking a parent drops grants it now covers', () => {
    const ids = toggleMemoryFolderSelection(byId('projects'), folders, ['projects-a', 'notes'])
    expect(ids).toEqual(['notes', 'projects'])
  })

  test('unchecking a folder removes it and every grant beneath it', () => {
    const ids = toggleMemoryFolderSelection(byId('projects'), folders, ['projects', 'projects-a', 'projects-ab', 'notes'])
    expect(ids).toEqual(['notes'])
    expect(effectiveIds(ids)).not.toContain('projects-a')
  })

  test('unchecking All Memory clears the whole selection but keeps unknown ids', () => {
    expect(toggleMemoryFolderSelection(byId('root'), folders, ['root', 'archive', 'missing'])).toEqual(['missing'])
  })

  test('opt-in folders can be added on top of All Memory and removed again', () => {
    const added = toggleMemoryFolderSelection(byId('archive'), folders, ['root'])
    expect(added).toEqual(['root', 'archive'])
    expect(state('archive', added)).toBe('selected')
    expect(state('archive-child', added)).toBe('inherited')
    expect(toggleMemoryFolderSelection(byId('archive'), folders, added)).toEqual(['root'])
  })

  test('checking All Memory drops grants it covers but keeps opt-in grants', () => {
    expect(toggleMemoryFolderSelection(byId('root'), folders, ['notes', 'archive'])).toEqual(['archive', 'root'])
  })

  test('parents with granted descendants are partial', () => {
    expect(state('projects', ['projects-ab'])).toBe('partial')
    expect(state('root', ['projects-ab'])).toBe('partial')
    expect(state('projects-b', ['projects-ab'])).toBe('none')
    expect(state('notes', ['nested-secret'])).toBe('partial')
  })

  test('select all reaches every folder with a minimal set of grants', () => {
    const ids = allMemoryFolderSelectionIds(folders)
    expect(ids).toEqual(['root', 'archive', 'nested-secret'])
    expect(effectiveIds(ids)).toHaveLength(folders.length)
  })

  test('normalize keeps missing ids and removes covered ones', () => {
    expect(normalizeMemoryFolderSelection(folders, ['missing', 'projects', 'projects-a', 'projects'])).toEqual(['missing', 'projects'])
  })

  test('summarises the scope for compact display', () => {
    expect(memoryFolderScopeSummary(folders, [])).toBe('None')
    expect(memoryFolderScopeSummary(folders, ['root'])).toBe('All memory')
    expect(memoryFolderScopeSummary(folders, ['root', 'archive'])).toBe('All memory + 1')
    expect(memoryFolderScopeSummary(folders, ['projects', 'projects-a'])).toBe('projects')
    expect(memoryFolderScopeSummary(folders, ['projects', 'notes', 'archive'])).toBe('notes + 2 more')
  })

  test('describes All Memory in terms of opt-in folders', () => {
    expect(allMemoryDescription(folders)).toBe('Every folder except 3 opt-in folders, including new ones')
    expect(allMemoryDescription([byId('root'), byId('notes')])).toBe('Every folder, including new ones')
  })
})
