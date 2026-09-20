import type { MemoryFolder } from '../api/types'

export function isAutoExcludedMemoryFolder(folder: Pick<MemoryFolder, 'autoMemoryExcluded'>): boolean {
  return folder.autoMemoryExcluded === true
}

/** Root defaults omit opted-out folders; explicit selections always remain available. */
export function isMemoryFolderSelected(
  folder: MemoryFolder,
  selectedIds: ReadonlySet<string>,
  rootSelected: boolean,
): boolean {
  return selectedIds.has(folder.id) || (rootSelected && !isAutoExcludedMemoryFolder(folder))
}

export function allMemoryFolderSelectionIds(folders: MemoryFolder[]): string[] {
  const root = folders.find((folder) => folder.isUncategorized)
  if (!root) return folders.map((folder) => folder.id)
  return [root.id, ...folders.filter(isAutoExcludedMemoryFolder).map((folder) => folder.id)]
}
