/**
 * memory:eval — repeatable evaluation of the auto-memory pipeline.
 *
 *   generate      synthetic cases from current memory chunks (appends to the dataset)
 *   review        write a local HTML page to accept/fix/reject unreviewed cases
 *   apply-review  import the review page's JSON export
 *   run           run conditions on isolated data-dir snapshots, judge, report
 *   report        re-print a stored run (optionally against another)
 *   list          list stored runs
 *   prepare       index the committed fixture corpus
 *
 * --dataset personal (default) evaluates the live memory with a dataset kept in
 * the data dir; --dataset fixture evaluates a committed fictional corpus
 * (tests/memory-eval) indexed into its own data dir, so it is shareable and
 * independent of anyone's memories.
 *
 * Everything that opens the app's database runs on a snapshot copy, so the
 * live data dir and a running server are never touched.
 */
import { execSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { getAppDataDir } from '../../core/data-dir.js'
import { createSnapshot, removeSnapshot } from './snapshot.js'
import { DEFAULT_MEMORY_RETRIEVAL_OPTIONS } from '../../core/memory/retrieval-options.js'
import type { CaseRunResult, CaseScore, EvalCase, EvalCondition, EvalDataset, EvalRun } from './types.js'

const PRESETS: Record<string, Omit<EvalCondition, 'name'>> = {
  curation: { reranker: false },
  reranker: { reranker: true },
}
const DEFAULT_CONDITIONS = 'curation,reranker'
const DEFAULT_MODEL = process.env.MEMORY_EVAL_MODEL || 'deepseek/deepseek-v4.1-flash'
/** Per-request price of the configured rerank model (OpenRouter bills Cohere rerank per search). */
const DEFAULT_RERANK_PRICE_USD = 0.002

const liveDataDir = getAppDataDir()
const evalDir = join(liveDataDir, 'evals', 'memory')
const runsDir = join(evalDir, 'runs')
const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, '..', '..', '..', 'tests', 'memory-eval')
/** Settings a fixture install inherits from the live one (models, not data). */
const INHERITED_SETTINGS = ['embedding', 'memoryReranker']

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    conditions: { type: 'string' },
    label: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    concurrency: { type: 'string' },
    'rerank-price': { type: 'string' },
    'fresh-planner': { type: 'boolean' },
    parallel: { type: 'boolean' },
    types: { type: 'string' },
    limit: { type: 'string' },
    all: { type: 'boolean' },
    facts: { type: 'string' },
    multi: { type: 'string' },
    'no-answer': { type: 'string' },
    folders: { type: 'string' },
    seed: { type: 'string' },
    against: { type: 'string' },
    dataset: { type: 'string' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})
const [command, ...rest] = positionals
const datasetName = args.dataset || 'personal'
if (!['personal', 'fixture'].includes(datasetName)) throw new Error('--dataset must be personal or fixture')
const datasetPath = datasetName === 'fixture' ? join(fixtureDir, 'dataset.json') : join(evalDir, 'dataset.json')

const activeSnapshots = new Set<string>()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const root of activeSnapshots) removeSnapshot(root)
    process.exit(130)
  })
}

mkdirSync(runsDir, { recursive: true })
switch (command) {
  case 'generate':
    if (datasetName === 'fixture') throw new Error('The fixture dataset is hand-written; edit tests/memory-eval/dataset.json instead')
    await withControlSnapshot(liveDataDir, generate)
    break
  case 'review': await withControlSnapshot(await sourceDataDir(), review); break
  case 'apply-review': applyReviewFile(rest[0]); break
  case 'run': {
    const source = await sourceDataDir()
    await withControlSnapshot(source, () => run(source))
    break
  }
  case 'prepare': await ensureFixture(); break
  case 'report': report(rest[0]); break
  case 'list': listRuns(); break
  default: printHelp(); process.exitCode = command && !args.help ? 2 : 0
}

function printHelp(): void {
  console.log(`Usage: pnpm --filter cynosure-server memory:eval <command> [options]

  prepare       [--force]                     index the fixture corpus (cached by content + embedding model)
  generate      [--facts 45] [--multi 15] [--no-answer 30] [--folders a,b] [--seed N] [--model M]
  review        [--all]                       writes ${join(evalDir, 'review.html')}
  apply-review  <exported.json>
  run           [--conditions ${DEFAULT_CONDITIONS}] [--label text] [--model M] [--judge-model M]
                [--provider id] [--concurrency 8] [--parallel] [--types single,multi] [--limit N]
                [--rerank-price 0.002] [--fresh-planner]
  report        [runId] [--against runId]
  list

All commands except generate take --dataset personal|fixture (default personal).
Conditions: ${Object.keys(PRESETS).join(', ')}, or custom: name=reranker:on+planner:on+curationPool:12
(retrieval options: ${Object.keys(DEFAULT_MEMORY_RETRIEVAL_OPTIONS).join(', ')})
Data: ${evalDir}`)
}

/** Run app code against a snapshot: env must point at it before any app module loads. */
async function withControlSnapshot(source: string, fn: () => Promise<void>): Promise<void> {
  const root = await createSnapshot(source)
  activeSnapshots.add(root)
  process.env.CYNOSURE_DATA_DIR = root
  process.env.CYNOSURE_DISABLE_MEMORY_WATCHERS = '1'
  try {
    const { loadSavedProviders } = await import('../../routes/providers.js')
    loadSavedProviders()
    await fn()
  } finally {
    removeSnapshot(root)
    activeSnapshots.delete(root)
  }
}

function loadDataset(): EvalDataset {
  return existsSync(datasetPath) ? JSON.parse(readFileSync(datasetPath, 'utf8')) as EvalDataset : { version: 1, cases: [] }
}

function saveDataset(dataset: EvalDataset): void {
  mkdirSync(dirname(datasetPath), { recursive: true })
  writeFileSync(datasetPath, JSON.stringify(dataset, null, 1))
}

async function modelRef(model?: string) {
  const { getGateway } = await import('../../core/gateway/gateway.js')
  const gateway = getGateway()
  const providerId = args.provider
    || [...gateway.getAllProviders().entries()].find(([, provider]) => provider.config.type === 'openrouter')?.[0]
    || gateway.getLastUsedProviderId()
  return { providerId, model: model || DEFAULT_MODEL }
}

async function generate(): Promise<void> {
  const { generateCases } = await import('./generate.js')
  const { usage } = await import('./llm.js')
  const dataset = loadDataset()
  const cases = await generateCases({
    facts: Number(args.facts || 45),
    multi: Number(args.multi || 15),
    noAnswer: Number(args['no-answer'] || 30),
    folders: args.folders?.split(',').map((folder) => folder.trim()).filter(Boolean),
    seed: Number(args.seed || Date.now() % 1_000_000),
    model: await modelRef(args.model),
    concurrency: Number(args.concurrency || 8),
  }, new Set(dataset.cases.map((item) => item.id)))
  dataset.cases.push(...cases)
  saveDataset(dataset)
  const counts = cases.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.type]: (acc[item.type] || 0) + 1 }), {})
  console.log(`Added ${cases.length} cases ${JSON.stringify(counts)} → ${datasetPath} (generation cost $${usage.usd.toFixed(3)})`)
  console.log('Next: memory:eval review, then apply-review the export before relying on the numbers.')
}

async function review(): Promise<void> {
  const { renderReviewPage } = await import('./review.js')
  const cases = loadDataset().cases.filter((item) => args.all || !item.review)
  if (!cases.length) return console.log('No unreviewed cases.')
  const path = join(evalDir, 'review.html')
  writeFileSync(path, await renderReviewPage(cases))
  console.log(`Review page with ${cases.length} cases: ${path}\n(local file — it contains memory text; open it in a browser)`)
}

function applyReviewFile(path?: string): void {
  if (!path) throw new Error('apply-review needs the exported JSON path')
  return void import('./review.js').then(({ applyReview }) => {
    const dataset = loadDataset()
    const result = applyReview(dataset, JSON.parse(readFileSync(path, 'utf8')))
    saveDataset(dataset)
    console.log(`Applied ${result.applied} verdicts (${result.bad} rejected; rejected cases are skipped by run).`)
  })
}

function parseConditions(spec: string): EvalCondition[] {
  return spec.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, custom] = part.split('=')
    if (!custom) {
      if (!PRESETS[name]) throw new Error(`Unknown condition "${name}". Presets: ${Object.keys(PRESETS).join(', ')}`)
      return { name, ...PRESETS[name] }
    }
    const condition: EvalCondition = { name, ...PRESETS.curation }
    for (const setting of custom.split('+')) {
      const [key, value] = setting.split(':')
      const parsed = value === 'on' || value === 'true' ? true : value === 'off' || value === 'false' ? false : Number(value)
      if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error(`Invalid value in "${setting}" (condition ${name})`)
      if (key === 'reranker' || key === 'planner') condition[key] = Boolean(parsed)
      else if (key in DEFAULT_MEMORY_RETRIEVAL_OPTIONS) condition.options = { ...condition.options, [key]: parsed }
      else throw new Error(`Invalid setting "${setting}" in condition ${name}. Known: reranker, planner, ${Object.keys(DEFAULT_MEMORY_RETRIEVAL_OPTIONS).join(', ')}`)
    }
    return condition
  })
}

async function sourceDataDir(): Promise<string> {
  return datasetName === 'fixture' ? ensureFixture() : liveDataDir
}

/**
 * Index the committed corpus into a cached fixture install. The cache key covers
 * corpus content and the inherited model settings, so changing either rebuilds.
 */
async function ensureFixture(): Promise<string> {
  const corpusDir = join(fixtureDir, 'corpus')
  const live = new Database(join(liveDataDir, 'sqlite', 'cynosure.db'), { readonly: true, fileMustExist: true })
  const providers = live.prepare('SELECT * FROM providers').all() as Array<Record<string, unknown>>
  const settings = live.prepare(`SELECT key, value_json FROM settings WHERE key IN (${INHERITED_SETTINGS.map(() => '?').join(', ')})`).all(...INHERITED_SETTINGS) as Array<{ key: string; value_json: string }>
  live.close()

  const hash = createHash('sha256')
  for (const file of listFiles(corpusDir)) hash.update(relative(corpusDir, file)).update(readFileSync(file))
  hash.update(JSON.stringify(settings.filter((setting) => setting.key !== 'memoryReranker')))
  const root = join(evalDir, 'fixture', `fixture-${hash.digest('hex').slice(0, 12)}`)
  const manifestPath = join(root, 'manifest.json')
  if (existsSync(manifestPath) && !args.force) return join(root, 'data')

  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  cpSync(corpusDir, join(root, 'data', 'memories'), { recursive: true })
  const jobPath = join(root, 'prepare-job.json')
  writeFileSync(jobPath, JSON.stringify({ providers, settings, manifestPath, manifest: { install: root } }))
  console.log(`Preparing fixture install ${root}...`)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, join(here, `prepare${extname(fileURLToPath(import.meta.url))}`), jobPath], {
        env: { ...process.env, CYNOSURE_DATA_DIR: root, CYNOSURE_DISABLE_MEMORY_WATCHERS: '1' },
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`fixture preparation exited with ${code}`)))
    })
  } finally {
    rmSync(jobPath, { force: true }) // contains provider credentials
  }
  // Older installs belong to previous corpus or model versions.
  for (const entry of readdirSync(dirname(root))) {
    if (entry.startsWith('fixture-') && join(dirname(root), entry) !== root) rmSync(join(dirname(root), entry), { recursive: true, force: true })
  }
  return join(root, 'data')
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)])
}

async function run(source: string): Promise<void> {
  let conditions = parseConditions(args.conditions || DEFAULT_CONDITIONS)
  const types = args.types?.split(',')
  let cases = loadDataset().cases.filter((item) => item.review?.verdict !== 'bad' && (!types || types.includes(item.type)))
  if (args.limit) cases = cases.slice(0, Number(args.limit))
  if (!cases.length) throw new Error(`No cases to run. Generate some first: memory:eval generate (dataset: ${datasetPath})`)
  const curator = await modelRef(args.model)
  const judge = await modelRef(args['judge-model'] || args.model)
  const concurrency = Number(args.concurrency || 8)
  const startedAt = Date.now()
  // Dataset in the id: concurrent runs on different datasets must not overwrite each other.
  const id = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${datasetName}`
  console.log(`Running ${cases.length} cases × ${conditions.length} conditions (${conditions.map((c) => c.name).join(', ')}), curator ${curator.model}`)
  // Rerank APIs bill per search, and a planned turn searches up to three queries.
  const rerankPrice = Number(args['rerank-price'] || DEFAULT_RERANK_PRICE_USD)
  const rerankConditions = conditions.filter((condition) => condition.reranker)
  if (rerankConditions.length) {
    const searches = cases.length * rerankConditions.reduce((sum, condition) => sum + (condition.planner ? 3 : 1), 0)
    console.log(`Note: ${rerankConditions.length} reranker condition(s) make up to ${searches} rerank requests (≈ $${(searches * rerankPrice).toFixed(2)} at $${rerankPrice}/request).`)
  }
  const plannerCacheDir = join(evalDir, 'planner-cache')
  mkdirSync(plannerCacheDir, { recursive: true })

  const runCondition = async (condition: EvalCondition) => {
    const root = await createSnapshot(source)
    activeSnapshots.add(root)
    const jobPath = join(root, 'job.json')
    const outPath = join(root, 'results.json')
    writeFileSync(jobPath, JSON.stringify({ cases, condition, curator, concurrency, outPath, plannerCacheDir: args['fresh-planner'] ? undefined : plannerCacheDir }))
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [...process.execArgv, join(here, `worker${extname(fileURLToPath(import.meta.url))}`), jobPath], {
          env: { ...process.env, CYNOSURE_DATA_DIR: root, CYNOSURE_DISABLE_MEMORY_WATCHERS: '1' },
          stdio: ['ignore', 'inherit', 'inherit'],
        })
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`condition ${condition.name} worker exited with ${code}`)))
      })
      const output = JSON.parse(readFileSync(outPath, 'utf8')) as { results: CaseRunResult[]; curatorUsd: number; rerankRequests?: number }
      console.log(`  ${condition.name}: ${output.results.length} cases done`)
      return output
    } finally {
      removeSnapshot(root)
      activeSnapshots.delete(root)
    }
  }
  // A failing condition must not abort (and orphan) the others.
  const settled = args.parallel
    ? await Promise.allSettled(conditions.map(runCondition))
    : await conditions.reduce<Promise<Array<PromiseSettledResult<Awaited<ReturnType<typeof runCondition>>>>>>(
      async (acc, condition) => [...await acc, ...await Promise.allSettled([runCondition(condition)])], Promise.resolve([]))
  const failed = conditions.filter((_, index) => settled[index].status === 'rejected')
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') console.error(`  ${conditions[index].name} failed: ${outcome.reason}`)
  }
  if (failed.length === conditions.length) throw new Error('Every condition failed')
  const outputs = settled.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : [])
  conditions = conditions.filter((condition) => !failed.includes(condition))

  const scores = await scoreAll(cases, outputs.flatMap((output) => output.results), judge, concurrency * 2)
  const { usage } = await import('./llm.js')
  const runRecord: EvalRun = {
    id, label: args.label, dataset: datasetName, startedAt, finishedAt: Date.now(), gitCommit: gitCommit(),
    curator, judge, conditions, datasetSize: cases.length, scores,
    cost: {
      curatorUsd: outputs.reduce((sum, output) => sum + output.curatorUsd, 0),
      judgeUsd: usage.usd,
      rerankRequests: outputs.reduce((sum, output) => sum + (output.rerankRequests || 0), 0),
      rerankUsd: outputs.reduce((sum, output) => sum + (output.rerankRequests || 0), 0) * rerankPrice,
    },
  }
  writeFileSync(join(runsDir, `${id}.json`), JSON.stringify(runRecord))
  const { renderReport } = await import('./report.js')
  const text = renderReport(runRecord, previousRun(runRecord))
  writeFileSync(join(runsDir, `${id}.md`), text)
  console.log(`\n${text}\n\nSaved ${join(runsDir, `${id}.md`)}`)
}

async function scoreAll(cases: EvalCase[], results: CaseRunResult[], judge: { providerId?: string; model?: string }, concurrency: number): Promise<CaseScore[]> {
  const { scoreRetrieval, selectionScores, isNoAnswerCase, JUDGE_SUPPORT_PROMPT, JUDGE_NO_ANSWER_PROMPT } = await import('./score.js')
  const { completeJson, mapLimit } = await import('./llm.js')
  const cachePath = join(evalDir, 'judge-cache.json')
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown> : {}
  const byId = new Map(cases.map((item) => [item.id, item]))

  const scores = await mapLimit(results, concurrency, async (result): Promise<CaseScore> => {
    const item = byId.get(result.caseId)!
    const noAnswer = isNoAnswerCase(item)
    const base = {
      caseId: item.id, condition: result.condition, type: item.type, folder: item.folder,
      ms: result.ms, injected: !!result.injected.trim(), selectedCount: result.selected.length,
      fallback: result.selectionMethod === 'ranked-fallback',
      correctiveRetry: result.correctiveRetry, ...scoreRetrieval(item, result), ...selectionScores(item, result),
    }
    if (result.error) return { ...base, error: result.error }
    // Real cases have doc-level gold and no reference answer: retrieval metrics only.
    if (!noAnswer && !item.answer) return base
    if (!result.injected.trim()) return noAnswer ? { ...base, misleading: false } : { ...base, support: 'none' }
    const key = createHash('sha1').update(JSON.stringify([judge.model, noAnswer, item.query, item.answer, result.injected])).digest('hex')
    if (!cache[key]) {
      cache[key] = await completeJson(judge, noAnswer ? JUDGE_NO_ANSWER_PROMPT : JUDGE_SUPPORT_PROMPT,
        `Question: ${item.query}\n${noAnswer ? '' : `Reference answer: ${item.answer}\n`}\nCONTEXT:\n${result.injected.slice(0, 12_000)}`, { maxTokens: 200 })
        .catch(() => null)
    }
    const verdict = cache[key] as { verdict?: CaseScore['support']; answers?: boolean } | null
    if (!verdict) return base
    return noAnswer ? { ...base, misleading: !!verdict.answers } : { ...base, support: verdict.verdict || 'none' }
  })
  writeFileSync(cachePath, JSON.stringify(cache))
  return scores
}

function storedRuns(): EvalRun[] {
  return readdirSync(runsDir).filter((file) => file.endsWith('.json')).sort()
    .map((file) => JSON.parse(readFileSync(join(runsDir, file), 'utf8')) as EvalRun)
    .filter((stored) => (stored.dataset || 'personal') === datasetName)
}

/** Most recent earlier run sharing at least one condition name. */
function previousRun(current: EvalRun): EvalRun | undefined {
  const names = new Set(current.conditions.map((condition) => condition.name))
  return storedRuns().filter((stored) => stored.id < current.id && stored.conditions.some((condition) => names.has(condition.name))).at(-1)
}

function report(runId?: string): void {
  void import('./report.js').then(({ renderReport }) => {
    const runs = storedRuns()
    const current = runId ? runs.find((stored) => stored.id === runId) : runs.at(-1)
    if (!current) throw new Error(runId ? `Run ${runId} not found` : 'No stored runs')
    const against = args.against ? runs.find((stored) => stored.id === args.against) : previousRun(current)
    console.log(renderReport(current, against))
  })
}

function listRuns(): void {
  for (const stored of storedRuns()) {
    console.log(`${stored.id}  ${(stored.dataset || 'personal').padEnd(9)} ${(stored.label || '').padEnd(28)} ${stored.datasetSize} cases  ${stored.conditions.map((c) => c.name).join(',')}  ${stored.gitCommit || ''}`)
  }
}

function gitCommit(): string | undefined {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return dirty ? `${commit}-dirty` : commit
  } catch {
    return undefined
  }
}
