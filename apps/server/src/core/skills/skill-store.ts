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
    if (!ids.length) return []
    const seen = new Set<string>()
    return ids
        .map((id) => id.trim())
        .filter(Boolean)
        .filter((id) => {
            if (seen.has(id)) return false
            seen.add(id)
            return true
        })
        .map(getSkill)
        .filter((skill): skill is SkillData => Boolean(skill && (!options.enabledOnly || skill.enabled)))
}

export function createSkill(input: CreateSkillInput): SkillData {
    const name = cleanString(input.name)
    const content = typeof input.content === 'string' ? input.content.trim() : ''
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
    const nextContent = input.content !== undefined ? input.content.trim() : existing.content
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
    return result.changes > 0
}
