import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs'
import { basename, extname, join } from 'path'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getSkillsDir } from '../data-dir.js'

export interface SkillData {
    id: string
    name: string
    description: string
    category: string
    content: string
    enabled: boolean
    createdAt: number
    updatedAt: number
}

export interface CreateSkillInput {
    id?: string
    name: string
    description?: string
    category?: string
    content: string
    enabled?: boolean
}

export type UpdateSkillInput = Partial<CreateSkillInput>

interface ParsedSkillFile {
    data: SkillData
    filePath: string
}

type FrontmatterValue = string | boolean | string[]
type Frontmatter = Record<string, FrontmatterValue>

function cleanString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function cleanId(value: unknown): string {
    return cleanString(value)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

function slugify(value: string): string {
    return cleanId(value) || `skill-${nanoid(6)}`
}

function ensureSkillsDir(): string {
    const dir = getSkillsDir()
    mkdirSync(dir, { recursive: true })
    return dir
}

export function normalizeSkillIds(ids: unknown): string[] {
    if (!Array.isArray(ids)) return []

    const result: string[] = []
    const seen = new Set<string>()
    for (const raw of ids) {
        const id = cleanString(raw)
        if (!id || seen.has(id)) continue
        seen.add(id)
        result.push(id)
    }
    return result
}

function parseStoredSkillIds(raw: string): string[] {
    try {
        return normalizeSkillIds(JSON.parse(raw || '[]'))
    } catch {
        return []
    }
}

export function listSkills(options: { enabledOnly?: boolean } = {}): SkillData[] {
    const allSkills = readSkillFiles(ensureSkillsDir())
        .map(({ data }) => data)
        .sort(compareSkills)
    const skills = allSkills.filter((skill) => !options.enabledOnly || skill.enabled)
    return skills
}

export function getSkill(id: string): SkillData | null {
    return findSkillFile(id)?.data || null
}

export function getSkillsByIds(ids: string[], options: { enabledOnly?: boolean } = {}): SkillData[] {
    const normalizedIds = normalizeSkillIds(ids)
    if (!normalizedIds.length) return []

    const byId = new Map(listSkills(options).map((skill) => [skill.id, skill]))
    return normalizedIds
        .map((id) => byId.get(id))
        .filter((skill): skill is SkillData => Boolean(skill))
}

export function createSkill(input: CreateSkillInput): SkillData {
    const dir = ensureSkillsDir()
    const name = cleanString(input.name)
    const content = cleanString(input.content)
    if (!name) throw new Error('Skill name is required')
    if (!content) throw new Error('Skill content is required')

    let id = cleanId(input.id) || slugify(name)
    if (getSkill(id)) id = `${id}-${nanoid(6)}`

    const now = Date.now()
    const skill: SkillData = {
        id,
        name,
        description: cleanString(input.description),
        category: cleanString(input.category),
        content,
        enabled: input.enabled !== false,
        createdAt: now,
        updatedAt: now,
    }
    writeSkillMarkdown(join(dir, uniqueSkillFileName(dir, name, id)), skill)
    return getSkill(id)!
}

export function updateSkill(id: string, input: UpdateSkillInput): SkillData | null {
    const existing = findSkillFile(id)
    if (!existing) return null

    const nextName = input.name !== undefined ? cleanString(input.name) : existing.data.name
    const nextContent = input.content !== undefined ? cleanString(input.content) : existing.data.content
    if (!nextName) throw new Error('Skill name is required')
    if (!nextContent) throw new Error('Skill content is required')

    const next: SkillData = {
        ...existing.data,
        name: nextName,
        description: input.description !== undefined ? cleanString(input.description) : existing.data.description,
        category: input.category !== undefined ? cleanString(input.category) : existing.data.category,
        content: nextContent,
        enabled: input.enabled !== undefined ? input.enabled : existing.data.enabled,
        updatedAt: Date.now(),
    }
    writeSkillMarkdown(existing.filePath, next)
    return getSkill(id)
}

export function deleteSkill(id: string): boolean {
    const existing = findSkillFile(id)
    if (!existing) return false

    unlinkSync(existing.filePath)
    const db = getDb()
    db.prepare('DELETE FROM skill_embeddings WHERE skill_id = ?').run(id)

    const rows = db.prepare('SELECT id, skills_json FROM agents').all() as { id: string; skills_json: string }[]
    const update = db.prepare('UPDATE agents SET skills_json = ?, updated_at = ? WHERE id = ?')
    const now = Date.now()
    for (const row of rows) {
        const skillIds = parseStoredSkillIds(row.skills_json)
        if (!skillIds.includes(id)) continue
        update.run(JSON.stringify(skillIds.filter((skillId) => skillId !== id)), now, row.id)
    }
    return true
}

export function listSkillMarkdownFiles(): { name: string; content: string }[] {
    const dir = ensureSkillsDir()
    return readSkillFiles(dir)
        .map(({ filePath }) => ({
            name: basename(filePath),
            content: readFileSync(filePath, 'utf-8'),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
}

export function restoreSkillMarkdownFile(fileName: string, content: string): void {
    const dir = ensureSkillsDir()
    const parsed = parseSkillMarkdown(content, join(dir, safeMarkdownFileName(fileName)))
    const existing = findSkillFile(parsed.data.id)
    const targetPath = existing?.filePath
        || join(dir, uniqueSkillFileName(dir, parsed.data.name, parsed.data.id, safeMarkdownFileName(fileName)))
    writeSkillMarkdown(targetPath, parsed.data)
}

function findSkillFile(id: string): ParsedSkillFile | null {
    const skillId = cleanString(id)
    if (!skillId) return null
    return readSkillFiles(ensureSkillsDir()).find((skill) => skill.data.id === skillId) || null
}

function readSkillFiles(dir: string): ParsedSkillFile[] {
    const files = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
        .map((entry) => join(dir, entry.name))
        .sort((a, b) => a.localeCompare(b))

    const seen = new Set<string>()
    const skills: ParsedSkillFile[] = []
    for (const filePath of files) {
        try {
            const parsed = parseSkillMarkdown(readFileSync(filePath, 'utf-8'), filePath)
            if (seen.has(parsed.data.id)) {
                console.warn(`[skills] Ignoring duplicate skill id "${parsed.data.id}" in ${filePath}`)
                continue
            }
            seen.add(parsed.data.id)
            skills.push(parsed)
        } catch (err) {
            console.warn(`[skills] Failed to load ${filePath}:`, err)
        }
    }
    return skills
}

function parseSkillMarkdown(raw: string, filePath: string): ParsedSkillFile {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!match) throw new Error('Skill file is missing YAML frontmatter')

    const frontmatter = parseFrontmatter(match[1])
    const stats = existsSync(filePath) ? statSync(filePath) : null
    const id = cleanId(frontmatter.id) || slugify(basename(filePath, extname(filePath)))
    const name = cleanString(frontmatter.name) || titleFromId(id)
    const content = match[2].trim()
    if (!content) throw new Error('Skill content is required')

    return {
        filePath,
        data: {
            id,
            name,
            description: cleanString(frontmatter.description),
            category: cleanString(frontmatter.category),
            content,
            enabled: typeof frontmatter.enabled === 'boolean' ? frontmatter.enabled : true,
            createdAt: stats ? Math.round(stats.birthtimeMs) : Date.now(),
            updatedAt: stats ? Math.round(stats.mtimeMs) : Date.now(),
        },
    }
}

function parseFrontmatter(raw: string): Frontmatter {
    const result: Frontmatter = {}
    const lines = raw.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim() || line.trimStart().startsWith('#')) continue
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
        if (!match) continue

        const [, key, rest] = match
        if (rest.trim() === '') {
            const values: string[] = []
            while (i + 1 < lines.length) {
                const next = lines[i + 1]
                const item = next.match(/^\s*-\s*(.*)$/)
                if (!item) break
                values.push(parseScalar(item[1]) as string)
                i++
            }
            result[key] = values
        } else {
            result[key] = parseScalar(rest)
        }
    }
    return result
}

function parseScalar(raw: string): string | boolean {
    const value = raw.trim()
    if (value === 'true') return true
    if (value === 'false') return false
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        try {
            return JSON.parse(value)
        } catch {
            return value.slice(1, -1)
        }
    }
    return value
}

function writeSkillMarkdown(filePath: string, skill: SkillData): void {
    const markdown = [
        '---',
        `id: ${JSON.stringify(skill.id)}`,
        `name: ${JSON.stringify(skill.name)}`,
        `description: ${JSON.stringify(skill.description)}`,
        `category: ${JSON.stringify(skill.category)}`,
        `enabled: ${skill.enabled ? 'true' : 'false'}`,
        '---',
        '',
        skill.content.trim(),
        '',
    ].join('\n')
    writeFileSync(filePath, markdown, 'utf-8')
}

function uniqueSkillFileName(dir: string, name: string, id: string, preferred?: string): string {
    const base = safeMarkdownFileName(preferred || `${slugify(name || id)}.md`)
    if (!existsSync(join(dir, base))) return base

    const parsedBase = basename(base, '.md')
    let index = 2
    while (existsSync(join(dir, `${parsedBase}-${index}.md`))) index++
    return `${parsedBase}-${index}.md`
}

function safeMarkdownFileName(fileName: string): string {
    const base = basename(fileName || '').replace(/\.md$/i, '')
    return `${slugify(base)}.md`
}

function compareSkills(a: SkillData, b: SkillData): number {
    return `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`)
}

function titleFromId(id: string): string {
    return id
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ') || 'Untitled Skill'
}
