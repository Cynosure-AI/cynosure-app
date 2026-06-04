import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'

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
    name: string
    description?: string
    category?: string
    content: string
    enabled?: boolean
}

export type UpdateSkillInput = Partial<CreateSkillInput>

interface SkillRow {
    id: string
    name: string
    description: string
    category: string
    content: string
    enabled: number
    created_at: number
    updated_at: number
}

function rowToSkill(row: SkillRow): SkillData {
    return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        category: row.category || '',
        content: row.content || '',
        enabled: row.enabled !== 0,
        createdAt: row.created_at || 0,
        updatedAt: row.updated_at || 0,
    }
}

function cleanString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
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
    const db = getDb()
    const rows = options.enabledOnly
        ? db.prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY category, name').all()
        : db.prepare('SELECT * FROM skills ORDER BY category, name').all()
    return (rows as SkillRow[]).map(rowToSkill)
}

export function getSkill(id: string): SkillData | null {
    const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined
    return row ? rowToSkill(row) : null
}

export function getSkillsByIds(ids: string[], options: { enabledOnly?: boolean } = {}): SkillData[] {
    const normalizedIds = normalizeSkillIds(ids)
    if (!normalizedIds.length) return []

    const placeholders = normalizedIds.map(() => '?').join(', ')
    const rows = getDb()
        .prepare(`SELECT * FROM skills WHERE id IN (${placeholders})`)
        .all(...normalizedIds) as SkillRow[]

    const byId = new Map(rows
        .map(rowToSkill)
        .filter((skill) => !options.enabledOnly || skill.enabled)
        .map((skill) => [skill.id, skill]))

    return normalizedIds
        .map((id) => byId.get(id))
        .filter((skill): skill is SkillData => Boolean(skill))
}

export function createSkill(input: CreateSkillInput): SkillData {
    const name = cleanString(input.name)
    const content = cleanString(input.content)
    if (!name) throw new Error('Skill name is required')
    if (!content) throw new Error('Skill content is required')

    const id = nanoid()
    const now = Date.now()
    getDb().prepare(
        `INSERT INTO skills (id, name, description, category, content, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        name,
        cleanString(input.description),
        cleanString(input.category),
        content,
        input.enabled === false ? 0 : 1,
        now,
        now,
    )
    return getSkill(id)!
}

export function updateSkill(id: string, input: UpdateSkillInput): SkillData | null {
    const existing = getSkill(id)
    if (!existing) return null

    const nextName = input.name !== undefined ? cleanString(input.name) : existing.name
    const nextContent = input.content !== undefined ? cleanString(input.content) : existing.content
    if (!nextName) throw new Error('Skill name is required')
    if (!nextContent) throw new Error('Skill content is required')

    getDb().prepare(
        `UPDATE skills
         SET name = ?, description = ?, category = ?, content = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
    ).run(
        nextName,
        input.description !== undefined ? cleanString(input.description) : existing.description,
        input.category !== undefined ? cleanString(input.category) : existing.category,
        nextContent,
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        Date.now(),
        id,
    )
    return getSkill(id)
}

export function deleteSkill(id: string): boolean {
    const db = getDb()
    const result = db.prepare('DELETE FROM skills WHERE id = ?').run(id)
    db.prepare('DELETE FROM skill_embeddings WHERE skill_id = ?').run(id)
    if (result.changes > 0) {
        const rows = db.prepare('SELECT id, skills_json FROM agents').all() as { id: string; skills_json: string }[]
        const update = db.prepare('UPDATE agents SET skills_json = ?, updated_at = ? WHERE id = ?')
        const now = Date.now()
        for (const row of rows) {
            const skillIds = parseStoredSkillIds(row.skills_json)
            if (!skillIds.includes(id)) continue
            update.run(JSON.stringify(skillIds.filter((skillId) => skillId !== id)), now, row.id)
        }
    }
    return result.changes > 0
}
