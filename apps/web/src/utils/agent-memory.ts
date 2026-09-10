export function agentInternalName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

export function agentMemoryFolderName(internalName: string, name: string): string {
  return (internalName || name || 'agent')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    || 'agent'
}

export function agentMemoryRelativePath(internalName: string, name: string): string {
  return `.agents/${agentMemoryFolderName(internalName, name)}`
}
