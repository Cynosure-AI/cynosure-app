export type DocumentPreviewShape = 'lines' | 'table' | 'slide' | 'code' | 'archive'

export interface DocumentTypeStyle {
  /** Short family name shown under the icon, e.g. "Word". */
  name: string
  icon: string
  /** Which stylized page content the card sketches. */
  shape: DocumentPreviewShape
  /** Icon and label color. */
  text: string
  /** Soft background behind the page. */
  tint: string
  /** Solid fill for the icon badge and page accents. */
  fill: string
}

// Class strings are written out in full so Tailwind's scanner picks them up.
const PDF: DocumentTypeStyle = {
  name: 'PDF',
  icon: 'mdi:file-pdf-box',
  shape: 'lines',
  text: 'text-rose-600 dark:text-rose-300',
  tint: 'bg-rose-500/10',
  fill: 'bg-rose-500',
}

const WORD: DocumentTypeStyle = {
  name: 'Word',
  icon: 'mdi:file-word',
  shape: 'lines',
  text: 'text-blue-600 dark:text-blue-300',
  tint: 'bg-blue-500/10',
  fill: 'bg-blue-500',
}

const SPREADSHEET: DocumentTypeStyle = {
  name: 'Spreadsheet',
  icon: 'mdi:file-excel',
  shape: 'table',
  text: 'text-emerald-600 dark:text-emerald-300',
  tint: 'bg-emerald-500/10',
  fill: 'bg-emerald-500',
}

const DELIMITED: DocumentTypeStyle = {
  ...SPREADSHEET,
  name: 'Table',
  icon: 'mdi:file-delimited',
  text: 'text-teal-600 dark:text-teal-300',
  tint: 'bg-teal-500/10',
  fill: 'bg-teal-500',
}

const PRESENTATION: DocumentTypeStyle = {
  name: 'Slides',
  icon: 'mdi:file-powerpoint',
  shape: 'slide',
  text: 'text-orange-600 dark:text-orange-300',
  tint: 'bg-orange-500/10',
  fill: 'bg-orange-500',
}

const MARKDOWN: DocumentTypeStyle = {
  name: 'Markdown',
  icon: 'mdi:language-markdown',
  shape: 'lines',
  text: 'text-violet-600 dark:text-violet-300',
  tint: 'bg-violet-500/10',
  fill: 'bg-violet-500',
}

const PLAIN_TEXT: DocumentTypeStyle = {
  name: 'Text',
  icon: 'mdi:file-document-outline',
  shape: 'lines',
  text: 'text-slate-600 dark:text-slate-300',
  tint: 'bg-slate-500/10',
  fill: 'bg-slate-500',
}

const JSON_DATA: DocumentTypeStyle = {
  name: 'JSON',
  icon: 'mdi:code-json',
  shape: 'code',
  text: 'text-amber-600 dark:text-amber-300',
  tint: 'bg-amber-500/10',
  fill: 'bg-amber-500',
}

const ARCHIVE: DocumentTypeStyle = {
  name: 'Archive',
  icon: 'mdi:folder-zip',
  shape: 'archive',
  text: 'text-yellow-700 dark:text-yellow-300',
  tint: 'bg-yellow-500/10',
  fill: 'bg-yellow-500',
}

const GENERIC: DocumentTypeStyle = {
  name: 'Document',
  icon: 'lucide:file-text',
  shape: 'lines',
  text: 'text-ink-secondary',
  tint: 'bg-theme-800/40',
  fill: 'bg-theme-500',
}

const STYLES_BY_EXTENSION: Record<string, DocumentTypeStyle> = {
  pdf: PDF,
  doc: WORD,
  docx: WORD,
  odt: WORD,
  rtf: WORD,
  xls: SPREADSHEET,
  xlsx: SPREADSHEET,
  ods: SPREADSHEET,
  csv: DELIMITED,
  tsv: DELIMITED,
  ppt: PRESENTATION,
  pptx: PRESENTATION,
  odp: PRESENTATION,
  md: MARKDOWN,
  txt: PLAIN_TEXT,
  json: JSON_DATA,
  zip: ARCHIVE,
}

export function normalizeExtension(ext: string | null | undefined): string {
  return (ext || '').replace(/^\./, '').toLowerCase()
}

export function documentTypeStyle(ext: string | null | undefined): DocumentTypeStyle {
  return STYLES_BY_EXTENSION[normalizeExtension(ext)] ?? GENERIC
}

const THUMBNAIL_EXTENSIONS = new Set(['pdf'])

/** Server-rendered first-page thumbnail, for files served through `/api/files`. */
export function documentThumbnailHref(href: string, ext: string | null | undefined): string | null {
  if (!THUMBNAIL_EXTENSIONS.has(normalizeExtension(ext))) return null
  const [route, query] = href.split('?', 2)
  if (route !== '/api/files' || !query) return null
  const path = new URLSearchParams(query).get('path')
  return path ? `/api/files/thumbnail?path=${encodeURIComponent(path)}` : null
}
