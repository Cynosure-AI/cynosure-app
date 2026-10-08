import { Ajv, type ErrorObject, type Options, type ValidateFunction } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'

type JsonSchema = Record<string, unknown>
type Dialect = 'draft-07' | '2019-09' | '2020-12'
type AjvInstance = Ajv | Ajv2019 | Ajv2020

export interface ToolArgumentValidation {
    valid: boolean
    errors: string[]
}

// Tool schemas come from both local definitions and arbitrary MCP servers.
// Strict schema linting would reject useful provider extensions, while runtime
// value validation should still implement the complete JSON Schema vocabulary.
const AJV_OPTIONS: Options = {
    allErrors: true,
    strict: false,
    validateFormats: false,
}

// Canonical meta-schema IDs as registered by each Ajv class.
const META_SCHEMA_IDS: Record<Dialect, string> = {
    'draft-07': 'http://json-schema.org/draft-07/schema',
    '2019-09': 'https://json-schema.org/draft/2019-09/schema',
    '2020-12': 'https://json-schema.org/draft/2020-12/schema',
}

// Each Ajv class only knows its own dialect's meta-schema, so MCP servers that
// stamp 2019-09/2020-12 (Playwright MCP, Zod v4, pydantic v2, schemars) need a
// dedicated instance. Created lazily because each compiles its meta-schemas.
const ajvInstances = new Map<Dialect, AjvInstance>()
const validators = new WeakMap<JsonSchema, ValidateFunction>()

/** Validate tool arguments against the exact JSON Schema exposed to the LLM. */
export function validateToolArguments(value: unknown, schema: JsonSchema): ToolArgumentValidation {
    try {
        let validator = validators.get(schema)
        if (!validator) {
            const compiled = compileSchema(schema)
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

function compileSchema(schema: JsonSchema): ValidateFunction {
    const dialect = detectDialect(schema.$schema)
    // Schemas without $schema keep draft-07 semantics, matching local tool definitions.
    if (!dialect) return getAjv('draft-07').compile(schema)
    const metaSchemaId = META_SCHEMA_IDS[dialect]
    // Ajv resolves $schema by exact ID, so normalize spelling variants
    // (http vs https, trailing '#') to the ID it registered.
    const normalized = schema.$schema === metaSchemaId ? schema : { ...schema, $schema: metaSchemaId }
    return getAjv(dialect).compile(normalized)
}

function detectDialect($schema: unknown): Dialect | undefined {
    if ($schema === undefined) return undefined
    if (typeof $schema !== 'string') throw new Error('$schema must be a string')
    const uri = $schema.trim().replace(/^https?:\/\//, '').replace(/#$/, '')
    if (uri === 'json-schema.org/draft-07/schema') return 'draft-07'
    if (uri === 'json-schema.org/draft/2019-09/schema') return '2019-09'
    if (uri === 'json-schema.org/draft/2020-12/schema') return '2020-12'
    throw new Error(`unsupported JSON Schema dialect "${$schema}" (supported: draft-07, 2019-09, 2020-12)`)
}

function getAjv(dialect: Dialect): AjvInstance {
    let instance = ajvInstances.get(dialect)
    if (!instance) {
        instance = dialect === '2020-12'
            ? new Ajv2020(AJV_OPTIONS)
            : dialect === '2019-09'
                ? new Ajv2019(AJV_OPTIONS)
                : new Ajv(AJV_OPTIONS)
        ajvInstances.set(dialect, instance)
    }
    return instance
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
    if (error.keyword === 'unevaluatedProperties') {
        const property = (error.params as { unevaluatedProperty?: string }).unevaluatedProperty
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
