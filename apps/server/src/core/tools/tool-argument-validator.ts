import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'

type JsonSchema = Record<string, unknown>

export interface ToolArgumentValidation {
    valid: boolean
    errors: string[]
}

// Tool schemas come from both local definitions and arbitrary MCP servers.
// Strict schema linting would reject useful provider extensions, while runtime
// value validation should still implement the complete JSON Schema vocabulary.
const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false,
})
const validators = new WeakMap<JsonSchema, ValidateFunction>()

/** Validate tool arguments against the exact JSON Schema exposed to the LLM. */
export function validateToolArguments(value: unknown, schema: JsonSchema): ToolArgumentValidation {
    try {
        let validator = validators.get(schema)
        if (!validator) {
            const compiled = ajv.compile(schema)
            validators.set(schema, compiled)
            validator = compiled
        }
        if (validator(value)) return { valid: true, errors: [] }
        return {
            valid: false,
            errors: (validator.errors || []).map(formatValidationError),
        }
    } catch (err) {
        // A malformed third-party schema must fail closed instead of allowing
        // an unvalidated call to mutate external state.
        return { valid: false, errors: [`tool schema is invalid: ${(err as Error).message}`] }
    }
}

function formatValidationError(error: ErrorObject): string {
    const path = formatInstancePath(error.instancePath)
    if (error.keyword === 'required') {
        const missing = (error.params as { missingProperty?: string }).missingProperty
        return `${path}.${missing || '?'} is required`
    }
    if (error.keyword === 'additionalProperties') {
        const property = (error.params as { additionalProperty?: string }).additionalProperty
        return `${path}.${property || '?'} is not allowed`
    }
    return `${path} ${error.message || `failed ${error.keyword} validation`}`
}

function formatInstancePath(instancePath: string): string {
    if (!instancePath) return '$'
    return instancePath
        .split('/')
        .slice(1)
        .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((path, segment) => /^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`, '$')
}
