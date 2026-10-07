import type { LLMProviderConfig, ModelListType } from '@/api/types'

export type ProviderType = LLMProviderConfig['type']

/** Provider choices in the order the add-provider forms list them. */
export const PROVIDER_OPTIONS: { value: ProviderType; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'requesty', label: 'Requesty' },
  { value: 'groq', label: 'Groq' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'grok', label: 'Grok (xAI)' },
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'lmstudio', label: 'LM Studio (local)' },
  { value: 'unsloth', label: 'Unsloth Studio (local)' },
]

export const PROVIDER_DISPLAY_NAMES: Record<ProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  requesty: 'Requesty',
  groq: 'Groq',
  mistral: 'Mistral',
  grok: 'Grok',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  unsloth: 'Unsloth Studio',
}

export const DEFAULT_PROVIDER_BASE_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: '',
  lmstudio: 'http://localhost:1234/v1',
  grok: 'https://api.x.ai/v1',
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  requesty: 'https://router.requesty.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  unsloth: 'http://localhost:8888/v1',
}

export const DEFAULT_PROVIDER_MODELS: Record<ProviderType, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-3.1-flash-lite-preview',
  lmstudio: '',
  grok: 'grok-3-mini',
  ollama: '',
  openrouter: 'openai/gpt-4o',
  requesty: 'openai/gpt-4o',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest',
  unsloth: '',
}

/** Model types a chat provider can serve; used when listing models for a provider. */
export const RESPONSE_MODEL_TYPES: ModelListType[] = ['llm', 'image', 'video', 'transcription']

/** Image input has been enabled for every provider type except Anthropic. */
export function providerSupportsVision(type: ProviderType): boolean {
  return type !== 'anthropic'
}

const LOCAL_PROVIDER_TYPES = new Set<ProviderType>(['lmstudio', 'ollama', 'unsloth'])
const KEYLESS_PROVIDER_TYPES = new Set<ProviderType>(['lmstudio', 'ollama'])

/** Local servers have an editable base URL. */
export function isLocalProvider(type: ProviderType): boolean {
  return LOCAL_PROVIDER_TYPES.has(type)
}

/** Every provider needs an API key except local servers that run without authentication. */
export function providerRequiresApiKey(type: ProviderType): boolean {
  return !KEYLESS_PROVIDER_TYPES.has(type)
}

export function providerBaseUrl(type: ProviderType, baseUrl?: string): string {
  return isLocalProvider(type) ? (baseUrl?.trim() || DEFAULT_PROVIDER_BASE_URLS[type]) : DEFAULT_PROVIDER_BASE_URLS[type]
}

/** What is still missing before a provider form can be saved, or null when it is complete. */
export function providerFormProblem(form: { type: ProviderType; name: string; apiKey?: string; baseUrl?: string; defaultModel: string }): string | null {
  if (!form.name.trim()) return 'Enter a display name.'
  if (isLocalProvider(form.type) && !form.baseUrl?.trim()) return 'Enter the server base URL.'
  if (providerRequiresApiKey(form.type) && !form.apiKey?.trim()) return 'Enter an API key.'
  if (!form.defaultModel.trim()) return 'Choose a default model.'
  return null
}
