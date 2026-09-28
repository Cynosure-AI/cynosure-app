const BUILT_IN_NAMESPACE_ICONS: Record<string, string> = {
  'builtin:memory': 'lucide:brain-circuit',
  'builtin:scheduling': 'lucide:calendar-clock',
  'builtin:notifications': 'lucide:bell',
  'builtin:utility': 'lucide:wrench',
  'builtin:files': 'lucide:folder-tree',
}

export function getToolNamespaceIcon(namespaceId: string): string {
  return BUILT_IN_NAMESPACE_ICONS[namespaceId]
    ?? (namespaceId === 'builtin' ? 'lucide:blocks' : 'lucide:plug')
}
