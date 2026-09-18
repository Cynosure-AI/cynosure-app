import type { MemoryFolder } from '../api/types'

export const AUTO_EXCLUDED_MEMORY_FOLDER_NAMES = ['Archive', 'Subconscious', 'Secret', 'Hidden'] as const
const autoExcludedMemoryFolderNameSet = new Set(
  AUTO_EXCLUDED_MEMORY_FOLDER_NAMES.map((name) => name.toLowerCase()),
)

/** Match special folder names at any path depth, ignoring capitalization. */
export function isAutoExcludedMemoryFolder(folder: Pick<MemoryFolder, 'folderPath'>): boolean {
  return (folder.folderPath || '')
    .split('/')
    .some((segment) => autoExcludedMemoryFolderNameSet.has(segment.toLowerCase()))
}

/** Root defaults omit special folders; explicit selections always remain available. */
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
