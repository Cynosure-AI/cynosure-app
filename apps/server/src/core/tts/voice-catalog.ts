import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { PiperVoice, PiperVoiceDownload, PiperVoiceList, PiperVoiceQuality } from '@shared/types'
import { getAppDataDir } from '../data-dir.js'

/**
 * Piper voices come from two places. rhasspy's voices.json describes every
 * voice; sherpa-onnx runs only the converted copies (with model metadata and a
 * tokens file) that its author mirrors on Hugging Face. The catalog lists the
 * voices that exist in both.
 */
const PIPER_VOICES_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json'
const MIRROR_AUTHOR = 'csukuangfj'
const MIRROR_PREFIX = 'vits-piper-'
const MIRROR_LIST_URL = `https://huggingface.co/api/models?author=${MIRROR_AUTHOR}&search=${MIRROR_PREFIX}&limit=1000`
const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ESPEAK_DIR_NAME = 'espeak-ng-data'
/** espeak-ng-data is ~19 MB; used for progress before its file list is known. */
const ESPEAK_ESTIMATED_BYTES = 19 * 1024 * 1024
const ESPEAK_DOWNLOAD_CONCURRENCY = 6

/** A voice id is also a directory name, so only catalog-shaped ids are accepted. */
export const VOICE_ID_PATTERN = /^[A-Za-z]{2,3}_[A-Za-z]{2}-[A-Za-z0-9_]+-(?:x_low|low|medium|high)$/

const QUALITIES = new Set<PiperVoiceQuality>(['x_low', 'low', 'medium', 'high'])

type CatalogVoice = Omit<PiperVoice, 'installed'>

interface CatalogCache {
    fetchedAt: number
    voices: CatalogVoice[]
}

export interface InstalledVoicePaths {
    model: string
    tokens: string
    dataDir: string
    voice: CatalogVoice
}

let catalogMemo: CatalogCache | null = null
const downloads = new Map<string, PiperVoiceDownload>()
const activeDownloads = new Map<string, Promise<void>>()

export function getTtsDir(): string {
    return join(getAppDataDir(), 'tts')
}

function voicesDir(): string {
    return join(getTtsDir(), 'voices')
}

function espeakDir(): string {
    return join(getTtsDir(), ESPEAK_DIR_NAME)
}

function catalogFile(): string {
    return join(getTtsDir(), 'catalog.json')
}

function mirrorFileUrl(voiceId: string, path: string): string {
    return `https://huggingface.co/${MIRROR_AUTHOR}/${MIRROR_PREFIX}${voiceId}/resolve/main/${path}`
}

export function isValidVoiceId(voiceId: unknown): voiceId is string {
    return typeof voiceId === 'string' && VOICE_ID_PATTERN.test(voiceId)
}

/** Build catalog entries from rhasspy's voices.json, keeping only mirrored voices. */
export function buildCatalog(piperVoices: unknown, mirroredIds: Set<string>): CatalogVoice[] {
    if (!piperVoices || typeof piperVoices !== 'object') return []
    const voices: CatalogVoice[] = []
    for (const [id, raw] of Object.entries(piperVoices as Record<string, unknown>)) {
        if (!isValidVoiceId(id) || !mirroredIds.has(id) || !raw || typeof raw !== 'object') continue
        const entry = raw as {
            name?: unknown
            quality?: unknown
            num_speakers?: unknown
            language?: { code?: unknown; name_english?: unknown; country_english?: unknown }
            files?: Record<string, { size_bytes?: unknown }>
        }
        const quality = QUALITIES.has(entry.quality as PiperVoiceQuality) ? entry.quality as PiperVoiceQuality : 'medium'
        const modelFile = Object.entries(entry.files ?? {}).find(([path]) => path.endsWith('.onnx'))
        voices.push({
            id,
            name: typeof entry.name === 'string' ? entry.name : id,
            languageCode: typeof entry.language?.code === 'string' ? entry.language.code : id.split('-')[0],
            languageName: typeof entry.language?.name_english === 'string' ? entry.language.name_english : '',
            countryName: typeof entry.language?.country_english === 'string' ? entry.language.country_english : '',
            quality,
            numSpeakers: typeof entry.num_speakers === 'number' && entry.num_speakers > 0 ? entry.num_speakers : 1,
            sizeBytes: typeof modelFile?.[1].size_bytes === 'number' ? modelFile[1].size_bytes : 0,
        })
    }
    return voices.sort((a, b) => a.languageName.localeCompare(b.languageName)
        || a.languageCode.localeCompare(b.languageCode)
        || a.name.localeCompare(b.name)
        || [...QUALITIES].indexOf(a.quality) - [...QUALITIES].indexOf(b.quality))
}

async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`)
    return res.json()
}

async function fetchCatalog(): Promise<CatalogCache> {
    const [piperVoices, mirror] = await Promise.all([fetchJson(PIPER_VOICES_URL), fetchJson(MIRROR_LIST_URL)])
    const mirroredIds = new Set(
        (Array.isArray(mirror) ? mirror : [])
            .map((model: { id?: unknown }) => typeof model?.id === 'string' ? model.id : '')
            .filter((id) => id.startsWith(`${MIRROR_AUTHOR}/${MIRROR_PREFIX}`))
            .map((id) => id.slice(`${MIRROR_AUTHOR}/${MIRROR_PREFIX}`.length)),
    )
    return { fetchedAt: Date.now(), voices: buildCatalog(piperVoices, mirroredIds) }
}

function readCachedCatalog(): CatalogCache | null {
    try {
        const cache = JSON.parse(readFileSync(catalogFile(), 'utf8')) as CatalogCache
        return Array.isArray(cache.voices) && typeof cache.fetchedAt === 'number' ? cache : null
    } catch {
        return null
    }
}

/** The online catalog, cached on disk for a week; a stale copy is used when offline. */
async function loadCatalog(): Promise<CatalogCache> {
    catalogMemo ??= readCachedCatalog()
    if (catalogMemo && Date.now() - catalogMemo.fetchedAt < CATALOG_MAX_AGE_MS) return catalogMemo
    try {
        const fresh = await fetchCatalog()
        if (fresh.voices.length) {
            mkdirSync(getTtsDir(), { recursive: true })
            writeFileSync(catalogFile(), JSON.stringify(fresh))
            catalogMemo = fresh
        }
        return catalogMemo ?? fresh
    } catch (err) {
        if (catalogMemo) return catalogMemo
        throw err
    }
}

function readInstalledVoice(voiceId: string): CatalogVoice | null {
    const dir = join(voicesDir(), voiceId)
    if (!existsSync(join(dir, 'model.onnx')) || !existsSync(join(dir, 'tokens.txt'))) return null
    try {
        return JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8')) as CatalogVoice
    } catch {
        return null
    }
}

function listInstalledVoices(): CatalogVoice[] {
    if (!existsSync(voicesDir())) return []
    return readdirSync(voicesDir())
        .filter(isValidVoiceId)
        .map(readInstalledVoice)
        .filter((voice): voice is CatalogVoice => voice !== null)
}

export async function listVoices(): Promise<PiperVoiceList> {
    const installed = new Map(listInstalledVoices().map((voice) => [voice.id, voice]))
    let catalog: CatalogVoice[] = []
    let catalogError: string | undefined
    try {
        catalog = (await loadCatalog()).voices
    } catch (err) {
        catalogError = `Voice catalog unavailable: ${err instanceof Error ? err.message : String(err)}`
    }
    const voices: PiperVoice[] = catalog.map((voice) => ({ ...voice, installed: installed.has(voice.id) }))
    for (const voice of installed.values()) {
        if (!catalog.some((entry) => entry.id === voice.id)) voices.push({ ...voice, installed: true })
    }
    return { voices, downloads: [...downloads.values()], ...(catalogError ? { catalogError } : {}) }
}

/** Files sherpa-onnx needs to run an installed voice, or null if it is not installed. */
export function getInstalledVoicePaths(voiceId: string): InstalledVoicePaths | null {
    if (!isValidVoiceId(voiceId) || !existsSync(join(espeakDir(), 'phontab'))) return null
    const voice = readInstalledVoice(voiceId)
    if (!voice) return null
    const dir = join(voicesDir(), voiceId)
    return { model: join(dir, 'model.onnx'), tokens: join(dir, 'tokens.txt'), dataDir: espeakDir(), voice }
}

async function downloadFile(url: string, dest: string, onBytes: (bytes: number) => void): Promise<void> {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url.split('/').pop()}`)
    mkdirSync(dirname(dest), { recursive: true })
    const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            onBytes(chunk.length)
            callback(null, chunk)
        },
    })
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), counter, createWriteStream(dest))
}

/** espeak-ng-data is the same in every mirrored voice; take it from the first voice installed. */
async function ensureEspeakData(voiceId: string, onBytes: (bytes: number) => void): Promise<void> {
    if (existsSync(join(espeakDir(), 'phontab'))) return
    const files: string[] = []
    let next: string | null = `https://huggingface.co/api/models/${MIRROR_AUTHOR}/${MIRROR_PREFIX}${voiceId}/tree/main/${ESPEAK_DIR_NAME}?recursive=true`
    while (next) {
        const res: Response = await fetch(next, { signal: AbortSignal.timeout(20_000) })
        if (!res.ok) throw new Error(`Could not list ${ESPEAK_DIR_NAME} (${res.status})`)
        for (const entry of await res.json() as Array<{ type?: string; path?: string }>) {
            if (entry.type === 'file' && typeof entry.path === 'string'
                && entry.path.startsWith(`${ESPEAK_DIR_NAME}/`) && !entry.path.split('/').includes('..')) {
                files.push(entry.path)
            }
        }
        next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null
    }
    if (!files.includes(`${ESPEAK_DIR_NAME}/phontab`)) throw new Error(`${ESPEAK_DIR_NAME} is incomplete in the voice mirror`)

    const partial = `${espeakDir()}.partial`
    rmSync(partial, { recursive: true, force: true })
    const queue = [...files]
    await Promise.all(Array.from({ length: ESPEAK_DOWNLOAD_CONCURRENCY }, async () => {
        for (let path = queue.shift(); path; path = queue.shift()) {
            await downloadFile(mirrorFileUrl(voiceId, path), join(partial, path.slice(ESPEAK_DIR_NAME.length + 1)), onBytes)
        }
    }))
    rmSync(espeakDir(), { recursive: true, force: true })
    renameSync(partial, espeakDir())
}

async function installVoice(voice: CatalogVoice, progress: PiperVoiceDownload, onProgress: (download: PiperVoiceDownload) => void): Promise<void> {
    let lastReport = 0
    const onBytes = (bytes: number) => {
        progress.loaded = Math.min(progress.total, progress.loaded + bytes)
        const now = Date.now()
        if (now - lastReport > 250) {
            lastReport = now
            onProgress({ ...progress })
        }
    }
    await ensureEspeakData(voice.id, onBytes)

    const target = join(voicesDir(), voice.id)
    const partial = `${target}.partial`
    rmSync(partial, { recursive: true, force: true })
    await downloadFile(mirrorFileUrl(voice.id, `${voice.id}.onnx`), join(partial, 'model.onnx'), onBytes)
    await downloadFile(mirrorFileUrl(voice.id, 'tokens.txt'), join(partial, 'tokens.txt'), onBytes)
    writeFileSync(join(partial, 'voice.json'), JSON.stringify(voice, null, 2))
    rmSync(target, { recursive: true, force: true })
    renameSync(partial, target)
}

/**
 * Start downloading a catalog voice. Resolves once the download has started;
 * progress and completion are reported through `onProgress`.
 */
export async function startVoiceDownload(voiceId: string, onProgress: (download: PiperVoiceDownload) => void): Promise<PiperVoiceDownload> {
    const running = downloads.get(voiceId)
    if (running?.status === 'downloading') return running
    const voice = (await loadCatalog()).voices.find((entry) => entry.id === voiceId)
    if (!voice) throw new Error(`Unknown voice: ${voiceId}`)

    const needsEspeak = !existsSync(join(espeakDir(), 'phontab'))
    const progress: PiperVoiceDownload = {
        voiceId,
        status: 'downloading',
        loaded: 0,
        total: voice.sizeBytes + (needsEspeak ? ESPEAK_ESTIMATED_BYTES : 0),
    }
    downloads.set(voiceId, progress)
    onProgress({ ...progress })

    const task = installVoice(voice, progress, onProgress)
        .then(() => {
            progress.status = 'done'
            progress.loaded = progress.total
        })
        .catch((err: unknown) => {
            progress.status = 'error'
            progress.error = err instanceof Error ? err.message : String(err)
            console.warn(`[tts] Failed to download voice ${voiceId}:`, progress.error)
            rmSync(join(voicesDir(), `${voiceId}.partial`), { recursive: true, force: true })
        })
        .finally(() => {
            activeDownloads.delete(voiceId)
            onProgress({ ...progress })
            // Finished downloads only need to be reported once.
            if (progress.status === 'done') downloads.delete(voiceId)
        })
    activeDownloads.set(voiceId, task)
    return { ...progress }
}

/** Wait for a running download; used by tests and shutdown. */
export function waitForVoiceDownload(voiceId: string): Promise<void> {
    return activeDownloads.get(voiceId) ?? Promise.resolve()
}

export function deleteVoice(voiceId: string): boolean {
    if (!isValidVoiceId(voiceId)) return false
    const dir = join(voicesDir(), voiceId)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    downloads.delete(voiceId)
    return true
}

/** Forget cached state; tests switch data directories between cases. */
export function resetVoiceCatalogState(): void {
    catalogMemo = null
    downloads.clear()
    activeDownloads.clear()
}
