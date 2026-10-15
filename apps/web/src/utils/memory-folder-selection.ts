import type { MemoryFolder } from '../api/types'

/**
 * Memory folder grants mirror the server's `expandMemoryFolderScope`:
 * - granting a folder grants it and every descendant, including folders created later;
 * - granting the root ("All Memory") grants every folder that is not opt-in;
 * - opt-in folders (`autoMemoryExcluded`) are only reached through an explicit grant
 *   of themselves or an ancestor. Opt-in is per folder and is not inherited.
 */

export type MemoryFolderSelectionState = 'selected' | 'inherited' | 'partial' | 'none'

export interface MemoryFolderSelectionInfo {
  state: MemoryFolderSelectionState
  /** For `inherited`: the closest granted folder that covers this one. */
  via?: MemoryFolder
}

export function isAutoExcludedMemoryFolder(folder: Pick<MemoryFolder, 'autoMemoryExcluded'>): boolean {
  return folder.autoMemoryExcluded === true
}

function isDescendantPath(path: string, ancestorPath: string): boolean {
  return Boolean(ancestorPath) && path.startsWith(`${ancestorPath}/`)
}

/** Whether a grant on `grant` gives access to `folder`. */
export function memoryFolderGrantCovers(grant: MemoryFolder, folder: MemoryFolder): boolean {
  if (grant.isUncategorized) return !isAutoExcludedMemoryFolder(folder)
  if (folder.isUncategorized) return false
  return folder.folderPath === grant.folderPath || isDescendantPath(folder.folderPath, grant.folderPath)
}

function grantedFolders(folders: readonly MemoryFolder[], selectedIds: Iterable<string>): MemoryFolder[] {
  const ids = new Set(selectedIds)
  return folders.filter((folder) => ids.has(folder.id))
}

function isStrictDescendant(folder: MemoryFolder, ancestor: MemoryFolder): boolean {
  if (folder.id === ancestor.id) return false
  if (ancestor.isUncategorized) return !folder.isUncategorized
  return !folder.isUncategorized && isDescendantPath(folder.folderPath, ancestor.folderPath)
}

export function memoryFolderSelectionInfo(
  folder: MemoryFolder,
  folders: readonly MemoryFolder[],
  selectedIds: Iterable<string>,
): MemoryFolderSelectionInfo {
  const grants = grantedFolders(folders, selectedIds)
  const covering = grants.filter((grant) => memoryFolderGrantCovers(grant, folder))
  const ancestors = covering.filter((grant) => grant.id !== folder.id)
  if (ancestors.length) {
    // Deepest ancestor first; the root has an empty path and sorts last.
    const via = ancestors.reduce((best, grant) => grant.folderPath.length > best.folderPath.length ? grant : best)
    return { state: 'inherited', via }
  }
  if (covering.length) return { state: 'selected' }
  const descendantGranted = folders.some((candidate) =>
    isStrictDescendant(candidate, folder) && grants.some((grant) => memoryFolderGrantCovers(grant, candidate)))
  return { state: descendantGranted ? 'partial' : 'none' }
}

/** Folders the model can read with this selection. */
export function effectiveMemoryFolders(folders: readonly MemoryFolder[], selectedIds: Iterable<string>): MemoryFolder[] {
  const grants = grantedFolders(folders, selectedIds)
  return folders.filter((folder) => grants.some((grant) => memoryFolderGrantCovers(grant, folder)))
}

/** Drop grants already covered by another grant. Unknown ids (missing folders) are kept. */
export function normalizeMemoryFolderSelection(folders: readonly MemoryFolder[], selectedIds: Iterable<string>): string[] {
  const ids = [...new Set(selectedIds)]
  const grants = grantedFolders(folders, ids)
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  return ids.filter((id) => {
    const folder = byId.get(id)
    return !folder || !grants.some((grant) => grant.id !== id && memoryFolderGrantCovers(grant, folder))
  })
}

/**
 * Checking a folder grants it (and its subtree). Unchecking removes it and every
 * grant beneath it. Inherited folders cannot be toggled on their own because the
 * covering grant would still include them.
 */
export function toggleMemoryFolderSelection(
  folder: MemoryFolder,
  folders: readonly MemoryFolder[],
  selectedIds: readonly string[],
): string[] {
  const { state } = memoryFolderSelectionInfo(folder, folders, selectedIds)
  if (state === 'inherited') return [...selectedIds]
  if (state === 'selected') {
    const removed = new Set(folders
      .filter((candidate) => candidate.id === folder.id || isStrictDescendant(candidate, folder))
      .map((candidate) => candidate.id))
    return selectedIds.filter((id) => !removed.has(id))
  }
  return normalizeMemoryFolderSelection(folders, [...selectedIds, folder.id])
}

/** Every folder, including opt-in ones. */
export function allMemoryFolderSelectionIds(folders: readonly MemoryFolder[]): string[] {
  const root = folders.find((folder) => folder.isUncategorized)
  if (!root) return normalizeMemoryFolderSelection(folders, folders.map((folder) => folder.id))
  return normalizeMemoryFolderSelection(folders, [root.id, ...folders.filter(isAutoExcludedMemoryFolder).map((folder) => folder.id)])
}

export function optInMemoryFolderCount(folders: readonly MemoryFolder[]): number {
  return folders.filter((folder) => !folder.isUncategorized && isAutoExcludedMemoryFolder(folder)).length
}

/** Secondary line for the "All Memory" row. */
export function allMemoryDescription(folders: readonly MemoryFolder[]): string {
  const optIn = optInMemoryFolderCount(folders)
  if (!optIn) return 'Every folder, including new ones'
  return `Every folder except ${optIn} opt-in folder${optIn === 1 ? '' : 's'}, including new ones`
}

export const OPT_IN_MEMORY_FOLDER_HINT = 'Opt-in: left out of All Memory. Only agents and chats that pick this folder (or a parent) can read it.'

/** Short label for the current scope, e.g. "All memory", "Projects + 2 more", "None". */
export function memoryFolderScopeSummary(folders: readonly MemoryFolder[], selectedIds: Iterable<string>): string {
  const grants = grantedFolders(folders, normalizeMemoryFolderSelection(folders, selectedIds))
  if (!grants.length) return 'None'
  const root = grants.find((grant) => grant.isUncategorized)
  const others = grants.filter((grant) => !grant.isUncategorized)
  if (root) return others.length ? `All memory + ${others.length}` : 'All memory'
  return others.length === 1 ? others[0].name : `${others[0].name} + ${others.length - 1} more`
}
