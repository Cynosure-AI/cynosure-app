/** The search text indexing writes for a chunk: document title and section
 * path give every chunk its document context for embeddings and BM25. */
export function chunkSearchText(chunk: { text: string; documentTitle?: string; sectionPath?: string }): string {
  return [
    chunk.documentTitle ? `Document: ${chunk.documentTitle}` : '',
    chunk.sectionPath && chunk.sectionPath !== chunk.documentTitle ? `Section: ${chunk.sectionPath}` : '',
    chunk.text,
  ].filter(Boolean).join('\n')
}
