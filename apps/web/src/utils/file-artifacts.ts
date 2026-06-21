export type FileArtifactLink = {
  href: string
  label: string
  ext: string
}

const ARTIFACT_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'odt',
  'rtf',
  'txt',
  'md',
  'csv',
  'tsv',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'zip',
  'json',
]

const artifactExtensionPattern = ARTIFACT_EXTENSIONS
  .map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

export function fileArtifactLinks(text: string): FileArtifactLink[] {
  const links: FileArtifactLink[] = []
  const seen = new Set<string>()
  const re = new RegExp(
    String.raw`/api/files\?path=([^)\]\s"'<>]+)|(?:^|\s)(/[^\s"'<>]+\.(?:${artifactExtensionPattern}))\b`,
    'gi'
  )
  let match: RegExpExecArray | null

  while ((match = re.exec(text || ''))) {
    const encodedPath = match[1]
    const rawPath = encodedPath ? decodeURIComponent(encodedPath) : match[2]
    if (!rawPath) continue
    const href = `/api/files?path=${encodeURIComponent(rawPath)}`
    if (seen.has(href)) continue
    seen.add(href)
    const filename = rawPath.split('/').pop() || 'document'
    const ext = (filename.split('.').pop() || '').toUpperCase()
    links.push({ href, label: filename, ext })
  }

  return links
}

export function fileArtifactKey(href: string): string {
  try {
    const parsed = new URL(href, window.location.origin)
    const path = parsed.searchParams.get('path')
    if (path) return `path:${path}`
  } catch {
    // Fall through to href-based matching.
  }
  return `href:${href}`
}
