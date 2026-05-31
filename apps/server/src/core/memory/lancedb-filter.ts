export function lanceDbStringLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

export function lanceDbEqFilter(field: string, value: string): string {
    return `${field} = ${lanceDbStringLiteral(value)}`
}

export function lanceDbInFilter(field: string, values: string[]): string | undefined {
    if (values.length === 0) return undefined
    if (values.length === 1) return lanceDbEqFilter(field, values[0])

    return `${field} IN (${values.map(lanceDbStringLiteral).join(', ')})`
}

export function andLanceDbFilters(...filters: Array<string | undefined>): string | undefined {
    const parts = filters.filter((filter): filter is string => Boolean(filter?.trim()))
    return parts.length ? parts.join(' AND ') : undefined
}
