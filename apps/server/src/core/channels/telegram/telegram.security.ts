/** Normalize Telegram user IDs from persisted, user-supplied channel config. */
export function normalizeTelegramUserIds(value: unknown): string[] {
    if (!Array.isArray(value)) return []

    const ids = value
        .map((id) => typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : '')
        .filter((id) => /^\d+$/.test(id) && id !== '0')

    return Array.from(new Set(ids))
}

export function isTelegramUserAllowed(allowedUserIds: ReadonlySet<string>, userId: number | undefined): boolean {
    return userId !== undefined && allowedUserIds.has(String(userId))
}
