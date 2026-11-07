import { extname } from 'path'

/** File types the /api/files route serves. Anything else is never linked to the UI. */
export const SERVABLE_FILE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif',
    '.mp4', '.webm', '.mov', '.ogg', '.mp3', '.wav', '.flac', '.m4a', '.aac',
    '.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.csv', '.tsv',
    '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.json',
    '.tar', '.gz', '.tgz', '.7z', '.rar',
])

export function isServableFile(filePath: string): boolean {
    return SERVABLE_FILE_EXTENSIONS.has(extname(filePath).toLowerCase())
}
