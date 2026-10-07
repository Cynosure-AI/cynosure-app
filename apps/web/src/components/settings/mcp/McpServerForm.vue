<script setup lang="ts">
import { envToText, textToEnv, type McpServerFormState, type McpTransport } from './mcp-server-form'

type EnvHint = { name: string; description?: string; required: boolean; sensitive?: boolean }

const form = defineModel<McpServerFormState>({ required: true })

const props = defineProps<{
  /** Known env vars for a local server (from its server.json); rendered as labelled fields. */
  envHints?: EnvHint[] | null
}>()

const transports: Array<{ value: McpTransport; label: string; description: string }> = [
  { value: 'stdio', label: 'Local command (stdio)', description: 'Runs a command on your machine' },
  { value: 'http', label: 'HTTP (remote)', description: 'Connects to a server by URL' },
  { value: 'sse', label: 'SSE (remote, legacy)', description: 'Older remote protocol; prefer HTTP' },
]

const inputClass = 'w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder:text-ink-faint'

function hintValue(name: string): string {
  return textToEnv(form.value.env)[name] ?? ''
}

function setHintValue(name: string, value: string): void {
  const env = textToEnv(form.value.env)
  if (value) env[name] = value
  else delete env[name]
  form.value.env = envToText(env)
}

/** Env entries not covered by a hint field, shown in the free-form textarea. */
function extraEnvText(): string {
  const hinted = new Set((props.envHints || []).map(hint => hint.name))
  return envToText(Object.fromEntries(Object.entries(textToEnv(form.value.env)).filter(([key]) => !hinted.has(key))))
}

function setExtraEnvText(text: string): void {
  const current = textToEnv(form.value.env)
  const hintedValues = Object.fromEntries((props.envHints || []).filter(hint => current[hint.name]).map(hint => [hint.name, current[hint.name]]))
  form.value.env = envToText({ ...hintedValues, ...textToEnv(text) })
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <span class="block text-sm text-ink-secondary mb-1">Transport</span>
      <div
        class="grid grid-cols-1 sm:grid-cols-3 gap-2"
        role="radiogroup"
        aria-label="Transport"
      >
        <button
          v-for="option in transports"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="form.transport === option.value"
          class="mcp-transport-option text-left rounded-lg border px-3 py-2 transition-colors"
          :class="form.transport === option.value
            ? 'border-accent-500 bg-accent-500/10'
            : 'border-theme-700 bg-theme-900 hover:border-theme-600'"
          @click="form.transport = option.value"
        >
          <span class="block text-sm font-medium text-theme-100">{{ option.label }}</span>
          <span class="block text-xs text-ink-secondary mt-0.5">{{ option.description }}</span>
        </button>
      </div>
    </div>

    <template v-if="form.transport === 'stdio'">
      <div>
        <label class="block text-sm text-ink-secondary mb-1">Command</label>
        <input
          v-model="form.command"
          type="text"
          placeholder="npx"
          :class="inputClass"
        >
      </div>
      <div>
        <label class="block text-sm text-ink-secondary mb-1">Arguments (one per line)</label>
        <textarea
          v-model="form.args"
          rows="3"
          placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/path/to/dir"
          :class="[inputClass, 'resize-y font-mono']"
        />
      </div>
      <div>
        <label class="block text-sm text-ink-secondary mb-1">Environment variables (KEY=value, one per line)</label>
        <div
          v-if="envHints?.length"
          class="space-y-2 mb-2"
        >
          <div
            v-for="hint in envHints"
            :key="hint.name"
          >
            <label class="flex items-center gap-1.5 text-xs text-ink-secondary mb-1">
              <span class="font-mono">{{ hint.name }}</span>
              <span
                v-if="hint.required"
                class="text-status-danger/80"
              >*</span>
              <span
                v-if="hint.description"
                class="text-ink-secondary/70 font-normal"
              >- {{ hint.description }}</span>
            </label>
            <input
              :value="hintValue(hint.name)"
              :type="hint.sensitive ? 'password' : 'text'"
              :placeholder="hint.name"
              :class="inputClass"
              @input="setHintValue(hint.name, ($event.target as HTMLInputElement).value)"
            >
          </div>
        </div>
        <textarea
          v-if="envHints?.length"
          :value="extraEnvText()"
          rows="2"
          placeholder="EXTRA_VAR=value"
          :class="[inputClass, 'resize-y font-mono']"
          @change="setExtraEnvText(($event.target as HTMLTextAreaElement).value)"
        />
        <textarea
          v-else
          v-model="form.env"
          rows="2"
          placeholder="API_KEY=sk-..."
          :class="[inputClass, 'resize-y font-mono']"
        />
      </div>
    </template>

    <template v-else>
      <div>
        <label class="block text-sm text-ink-secondary mb-1">URL</label>
        <input
          v-model="form.url"
          type="url"
          :placeholder="form.transport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'"
          :class="inputClass"
        >
      </div>
      <div>
        <label class="block text-sm text-ink-secondary mb-1">Headers (Header-Name: value, one per line)</label>
        <textarea
          v-model="form.headers"
          rows="3"
          placeholder="Authorization: Bearer ${API_TOKEN}"
          :class="[inputClass, 'resize-y font-mono']"
          spellcheck="false"
        />
        <p class="mt-1 text-xs text-ink-muted">
          Leave empty for servers that use OAuth — you will be asked to authorize in the browser if needed.
          Values can reference environment variables with <span class="font-mono">${VAR}</span>.
        </p>
      </div>
    </template>
  </div>
</template>
