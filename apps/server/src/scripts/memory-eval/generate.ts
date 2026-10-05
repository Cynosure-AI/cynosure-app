import * as lancedb from '@lancedb/lancedb'
import { join } from 'node:path'
import { getAppDataDir } from '../../core/data-dir.js'
import { getDb } from '../../db/database.js'
import { getActivePermanentMemoryTableName } from '../../core/memory/memory-index-manifest.js'
import { completeJson, mapLimit, type ModelRef } from './llm.js'
import { normalizeText } from './score.js'
import type { EvalCase } from './types.js'

export interface GenerateOptions {
  facts: number
  multi: number
  noAnswer: number
  folders?: string[]
  seed: number
  model: ModelRef
  concurrency: number
}

interface SourceChunk {
  id: string
  text: string
  file: string
  folderId: string
  chunkIndex: number
  title: string
}

const MIN_CHUNK_CHARS = 350

const SINGLE_PROMPT = `You build evaluation data for a personal memory assistant. The user owns these notes and asks his own assistant about facts stored in them. You get ONE note chunk.
Write questions the user would realistically type, whose answer is a specific fact found ONLY in this chunk (not general knowledge, not the document title). Avoid yes/no questions and copying long phrases.
Return JSON:
{"usable": true|false,
 "answer": "short answer",
 "answer_quote": "exact verbatim substring of the chunk (5-120 chars) containing the answer",
 "direct": "natural question in the chunk's language",
 "paraphrase": "same question, same language, different vocabulary (synonyms, indirect description, no distinctive keyword from the chunk)",
 "crosslang": "same question in ENGLISH if the chunk is German, otherwise in GERMAN",
 "crosslang_language": "en|de"}
usable=false if the chunk has no specific askable fact (headings only, boilerplate, link lists).`

const MULTI_PROMPT = `You build evaluation data for a personal memory assistant. You get TWO note chunks.
Write ONE realistic question whose complete answer needs a fact from chunk A AND a fact from chunk B (comparison, combination, person attribute plus related event). It must not be answerable from either chunk alone.
Return JSON {"usable": true|false, "question": "...", "answer": "...", "quote_a": "verbatim substring of A", "quote_b": "verbatim substring of B", "language": "de|en"}.
Use the chunks' language. usable=false if no natural question links them.`

const NO_ANSWER_PROMPT = `You build evaluation data for a personal memory assistant. You get one note chunk.
Write 2 realistic questions about the SAME person/topic whose answer is NOT in the chunk and is a specific detail notes are unlikely to contain (a date, a relative's name, a number, an unmentioned preference). They must sound answerable by these notes (near misses) but are not.
Return JSON {"questions": [{"question": "...", "language": "de|en"}]}. Mostly in the chunk's language.`

const VERIFY_NO_ANSWER_PROMPT = `You check evaluation data. The question was written to be UNANSWERABLE from the user's notes. You see the most similar note chunks.
Does any chunk directly answer the question? Return JSON {"answerable": true|false}.`

export async function generateCases(opts: GenerateOptions, existingIds: Set<string>): Promise<EvalCase[]> {
  const random = mulberry32(opts.seed)
  const chunks = await loadSourceChunks(opts.folders)
  if (!chunks.length) throw new Error('No indexed chunks found to generate cases from')
  const byFolder = groupBy(chunks, (chunk) => chunk.folderId)
  const now = Date.now()
  const prefix = `g${opts.seed}`
  const cases: EvalCase[] = []

  // Spread facts over folders (sqrt weighting keeps small folders represented).
  const picks = allocate(byFolder, opts.facts, random)
  const singles = await mapLimit(picks, opts.concurrency, async (chunk) => {
    const out = await completeJson<{ usable?: boolean; answer?: string; answer_quote?: string; direct?: string; paraphrase?: string; crosslang?: string; crosslang_language?: string }>(
      opts.model, SINGLE_PROMPT, `Document: ${chunk.title}\nFolder: ${chunk.folderId}\n\nChunk:\n${chunk.text.slice(0, 3_500)}`, { temperature: 0.3 },
    ).catch(() => null)
    if (!out?.usable || !out.answer_quote || !normalizeText(chunk.text).includes(normalizeText(out.answer_quote))) return null
    return { chunk, out }
  })
  singles.forEach((single, index) => {
    if (!single) return
    const group = `${prefix}-s${index}`
    const base = { group, answer: single.out.answer, gold: [{ file: single.chunk.file, quote: single.out.answer_quote }], goldMode: 'any' as const, folder: single.chunk.folderId, createdAt: now }
    for (const [type, query, language] of [
      ['single', single.out.direct, undefined],
      ['paraphrase', single.out.paraphrase, undefined],
      ['crosslang', single.out.crosslang, single.out.crosslang_language],
    ] as const) {
      if (query?.trim()) cases.push({ ...base, id: `${group}-${type}`, type, query: query.trim(), language })
    }
  })

  const pairs = pickPairs(chunks, opts.multi * 2, random)
  const multis = await mapLimit(pairs, opts.concurrency, async ([a, b]) => {
    const out = await completeJson<{ usable?: boolean; question?: string; answer?: string; quote_a?: string; quote_b?: string; language?: string }>(
      opts.model, MULTI_PROMPT, `Chunk A (${a.title}):\n${a.text.slice(0, 2_500)}\n\nChunk B (${b.title}):\n${b.text.slice(0, 2_500)}`, { temperature: 0.3 },
    ).catch(() => null)
    const grounded = out?.usable && out.question && out.quote_a && out.quote_b
      && normalizeText(a.text).includes(normalizeText(out.quote_a)) && normalizeText(b.text).includes(normalizeText(out.quote_b))
    return grounded ? { a, b, out: out! } : null
  })
  multis.filter(Boolean).slice(0, opts.multi).forEach((multi, index) => {
    const id = `${prefix}-m${index}`
    cases.push({
      id, group: id, type: 'multi', query: multi!.out.question!.trim(), answer: multi!.out.answer, language: multi!.out.language,
      gold: [{ file: multi!.a.file, quote: multi!.out.quote_a }, { file: multi!.b.file, quote: multi!.out.quote_b }],
      goldMode: 'all', folder: multi!.a.folderId, createdAt: now,
    })
  })

  const noAnswerSources = shuffle(chunks, random).slice(0, Math.ceil(opts.noAnswer / 2) + 2)
  const proposed = (await mapLimit(noAnswerSources, opts.concurrency, async (chunk) => {
    const out = await completeJson<{ questions?: Array<{ question?: string; language?: string }> }>(
      opts.model, NO_ANSWER_PROMPT, `Document: ${chunk.title}\n\nChunk:\n${chunk.text.slice(0, 3_000)}`, { temperature: 0.7 },
    ).catch(() => null)
    return (out?.questions || []).filter((q) => q.question?.trim()).slice(0, 2).map((q) => ({ chunk, question: q.question!.trim(), language: q.language }))
  })).flat()
  // Generated near-misses are often answered elsewhere; keep only verified ones.
  const verified = await mapLimit(proposed, opts.concurrency, async (item) => {
    const context = lexicalNeighbours(chunks, item.question, 12).map((chunk) => `[${chunk.file} #${chunk.chunkIndex}]\n${chunk.text.slice(0, 2_500)}`).join('\n\n')
    const check = await completeJson<{ answerable?: boolean }>(opts.model, VERIFY_NO_ANSWER_PROMPT, `Question: ${item.question}\n\n${context}`).catch(() => ({ answerable: true }))
    return check.answerable === false ? item : null
  })
  verified.filter(Boolean).slice(0, opts.noAnswer).forEach((item, index) => {
    const id = `${prefix}-n${index}`
    cases.push({ id, group: id, type: 'noanswer', query: item!.question, language: item!.language, gold: [], goldMode: 'any', folder: item!.chunk.folderId, createdAt: now })
  })

  return cases.filter((item) => !existingIds.has(item.id))
}

async function loadSourceChunks(folders?: string[]): Promise<SourceChunk[]> {
  const eligible = getDb().prepare('SELECT id, name FROM memory_folders WHERE auto_memory_excluded = 0').all() as Array<{ id: string; name: string }>
  const allowed = new Set(eligible.filter((folder) => !folders?.length || folders.includes(folder.id) || folders.includes(folder.name)).map((folder) => folder.id))
  const db = await lancedb.connect(join(getAppDataDir(), 'lancedb'))
  const table = await db.openTable(getActivePermanentMemoryTableName())
  const rows = await table.query().where("representationType = 'raw'").select(['id', 'text', 'sourceFile', 'folderId', 'chunkIndex', 'documentTitle']).toArray()
  return rows
    .filter((row) => allowed.has(String(row.folderId)) && String(row.text || '').length >= MIN_CHUNK_CHARS)
    .map((row) => ({ id: String(row.id), text: String(row.text), file: String(row.sourceFile), folderId: String(row.folderId), chunkIndex: Number(row.chunkIndex), title: String(row.documentTitle || row.sourceFile) }))
}

function allocate(byFolder: Map<string, SourceChunk[]>, total: number, random: () => number): SourceChunk[] {
  const folders = [...byFolder.entries()]
  const weights = folders.map(([, chunks]) => Math.sqrt(chunks.length))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  return folders.flatMap(([, chunks], index) => {
    const quota = Math.max(1, Math.round((total * weights[index]) / weightSum))
    return shuffle(chunks, random).slice(0, Math.min(quota, chunks.length))
  }).slice(0, Math.max(total, folders.length))
}

/** Pairs from the same document, or from different documents sharing a capitalised name. */
function pickPairs(chunks: SourceChunk[], count: number, random: () => number): Array<[SourceChunk, SourceChunk]> {
  const pairs: Array<[SourceChunk, SourceChunk]> = []
  const byDoc = [...groupBy(chunks, (chunk) => `${chunk.folderId}\0${chunk.file}`).values()].filter((group) => group.length >= 2)
  for (const group of shuffle(byDoc, random).slice(0, Math.ceil(count / 2))) {
    const [a, b] = shuffle(group, random)
    pairs.push([a, b])
  }
  const byName = new Map<string, SourceChunk[]>()
  for (const chunk of chunks) {
    for (const name of new Set(chunk.text.match(/\b[A-ZÄÖÜ][a-zäöüß]{3,}\b/g) || [])) {
      const list = byName.get(name) || []
      list.push(chunk)
      byName.set(name, list)
    }
  }
  const shared = [...byName.values()].filter((list) => new Set(list.map((chunk) => chunk.file)).size >= 2 && list.length <= 12)
  for (const list of shuffle(shared, random)) {
    if (pairs.length >= count) break
    const [a, ...rest] = shuffle(list, random)
    const b = rest.find((chunk) => chunk.file !== a.file)
    if (b) pairs.push([a, b])
  }
  return pairs
}

const STOPWORDS = new Set('der die das und oder ein eine einer wie was wer wann wo welche welcher welches ist hat war mit von für zu im in am an auf aus bei nach mein meine ich du er sie es wir the a an of to is was what which who when where how does did do his her my and or for with'.split(' '))

function lexicalNeighbours(chunks: SourceChunk[], query: string, limit: number): SourceChunk[] {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter((term) => !STOPWORDS.has(term))
  return chunks
    .map((chunk) => ({ chunk, hits: terms.filter((term) => chunk.text.toLowerCase().includes(term)).length }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map(({ chunk }) => chunk)
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const list = groups.get(key(item)) || []
    list.push(item)
    groups.set(key(item), list)
  }
  return groups
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
