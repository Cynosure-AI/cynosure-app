<script setup lang="ts">
/**
 * Tunes an assistant's generated avatar. Every setting starts on "auto", which
 * leaves it to the seed; the seed itself defaults to the assistant's name.
 */
import { computed, ref } from 'vue'
import { Icon } from '@iconify/vue'
import AgentAvatar from '../shared/AgentAvatar.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import type { AgentMood } from '../../composables/useAgentMood'
import {
  AVATAR_SHAPES, EMPTY_AVATAR_CONFIG, compactAvatarConfig, type AvatarConfig, type AvatarShape,
} from '../../utils/avatar'

const props = defineProps<{
  name: string
  avatar: AvatarConfig | null
}>()

const emit = defineEmits<{ update: [value: AvatarConfig | null] }>()

const config = computed<AvatarConfig>(() => ({ ...EMPTY_AVATAR_CONFIG, ...props.avatar }))
const isCustomised = computed(() => props.avatar !== null)

function patch(changes: Partial<AvatarConfig>): void {
  emit('update', compactAvatarConfig({ ...config.value, ...changes }))
}

const PREVIEW_MOODS: Array<{ mood: AgentMood; label: string }> = [
  { mood: 'idle', label: 'Idle' },
  { mood: 'thinking', label: 'Thinking' },
  { mood: 'happy', label: 'Happy' },
  { mood: 'surprised', label: 'Surprised' },
  { mood: 'unsure', label: 'Unsure' },
  { mood: 'sad', label: 'Sad' },
  { mood: 'mad', label: 'Mad' },
  { mood: 'sleepy', label: 'Sleepy' },
]
const previewMood = ref<AgentMood>('idle')

function shuffleSeed(): void {
  patch({ seed: Math.random().toString(36).slice(2, 10) })
}

function onSeedInput(event: Event): void {
  patch({ seed: (event.target as HTMLInputElement).value || null })
}

function selectShape(shape: AvatarShape | null): void {
  patch({ shape })
}

const DEFAULT_HUE = 210
const DEFAULT_TONE = 0.5
const customColor = computed(() => config.value.hue !== null || config.value.tone !== null)

function toggleCustomColor(enabled: boolean): void {
  patch(enabled ? { hue: DEFAULT_HUE, tone: DEFAULT_TONE } : { hue: null, tone: null })
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div class="flex shrink-0 flex-col items-center gap-2">
        <div class="h-24 w-24">
          <AgentAvatar
            :name="name"
            :avatar="avatar"
            :mood="previewMood"
            animate="always"
          />
        </div>
        <div
          class="flex max-w-56 flex-wrap justify-center gap-1"
          role="group"
          aria-label="Preview expression"
        >
          <button
            v-for="entry in PREVIEW_MOODS"
            :key="entry.mood"
            type="button"
            class="rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
            :class="previewMood === entry.mood ? 'bg-theme-700 text-theme-100' : 'text-ink-muted hover:bg-theme-800 hover:text-theme-200'"
            :aria-pressed="previewMood === entry.mood"
            @click="previewMood = entry.mood"
          >
            {{ entry.label }}
          </button>
        </div>
      </div>

      <div class="min-w-0 flex-1 space-y-4">
        <div>
          <label
            for="avatar-seed"
            class="mb-1.5 block text-sm text-ink-secondary"
          >Seed</label>
          <p class="mb-2 text-xs text-ink-faint">
            The face is generated from this text. Leave it empty to use the name, so renaming changes the face.
          </p>
          <div class="flex gap-2">
            <input
              id="avatar-seed"
              :value="config.seed ?? ''"
              type="text"
              maxlength="120"
              :placeholder="name || 'Name'"
              class="min-w-0 flex-1 rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
              @input="onSeedInput"
            >
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-lg bg-theme-700 px-3 py-1.5 text-xs text-theme-300 transition-colors hover:bg-theme-600"
              title="Generate a random face"
              @click="shuffleSeed"
            >
              <Icon
                icon="lucide:shuffle"
                class="h-3.5 w-3.5"
              />
              Shuffle
            </button>
            <button
              v-if="config.seed"
              type="button"
              class="rounded-lg bg-theme-800 px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-theme-700"
              title="Generate the face from the name again"
              @click="patch({ seed: null })"
            >
              Use name
            </button>
          </div>
        </div>

        <div>
          <span class="mb-1.5 block text-sm text-ink-secondary">Shape</span>
          <div
            class="grid grid-cols-6 gap-1.5 sm:grid-cols-11"
            role="radiogroup"
            aria-label="Avatar shape"
          >
            <button
              type="button"
              role="radio"
              :aria-checked="config.shape === null"
              class="flex aspect-square items-center justify-center rounded-lg border text-[11px] transition-colors"
              :class="config.shape === null ? 'border-accent-500 bg-accent-500/10 text-theme-100' : 'border-theme-700 text-ink-muted hover:border-theme-500'"
              title="Chosen by the seed"
              @click="selectShape(null)"
            >
              Auto
            </button>
            <button
              v-for="entry in AVATAR_SHAPES"
              :key="entry.shape"
              type="button"
              role="radio"
              :aria-checked="config.shape === entry.shape"
              :aria-label="entry.label"
              :title="entry.label"
              class="flex aspect-square items-center justify-center rounded-lg border p-1 transition-colors"
              :class="config.shape === entry.shape ? 'border-accent-500 bg-accent-500/10' : 'border-theme-700 hover:border-theme-500'"
              @click="selectShape(entry.shape)"
            >
              <AgentAvatar
                :name="name"
                :avatar="{ ...config, shape: entry.shape }"
              />
            </button>
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm text-ink-secondary">Custom color</span>
            <ToggleSwitch
              :model-value="customColor"
              label="Custom avatar color"
              size="md"
              @update:model-value="toggleCustomColor"
            />
          </div>
          <div
            v-if="customColor"
            class="mt-3 space-y-3"
          >
            <label class="flex items-center gap-3 text-xs text-ink-muted">
              <span class="w-10 shrink-0">Hue</span>
              <input
                :value="config.hue ?? DEFAULT_HUE"
                type="range"
                min="0"
                max="359"
                class="avatar-hue h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
                @input="patch({ hue: Number(($event.target as HTMLInputElement).value) })"
              >
            </label>
            <label class="flex items-center gap-3 text-xs text-ink-muted">
              <span class="w-10 shrink-0">Tone</span>
              <input
                :value="config.tone ?? DEFAULT_TONE"
                type="range"
                min="0"
                max="0.999"
                step="0.001"
                class="h-2 min-w-0 flex-1 cursor-pointer accent-accent-500"
                @input="patch({ tone: Number(($event.target as HTMLInputElement).value) })"
              >
            </label>
          </div>
        </div>

        <button
          v-if="isCustomised"
          type="button"
          class="inline-flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-theme-200"
          @click="emit('update', null)"
        >
          <Icon
            icon="lucide:rotate-ccw"
            class="h-3.5 w-3.5"
          />
          Reset to the face from the name
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.avatar-hue {
  background: linear-gradient(
    to right,
    oklch(0.7 0.14 0), oklch(0.7 0.14 60), oklch(0.7 0.14 120), oklch(0.7 0.14 180),
    oklch(0.7 0.14 240), oklch(0.7 0.14 300), oklch(0.7 0.14 359)
  );
}

.avatar-hue::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 9999px;
  background: white;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 0.35);
}

.avatar-hue::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 9999px;
  background: white;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 0.35);
}
</style>
