<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { PiperVoice, VoiceAutoRead } from '@shared/types'
import { useVoiceOutputStore } from '../../stores/voice-output.store'
import { useCynoStore } from '../../stores/cyno.store'
import { useSpeechPlayer } from '../../composables/useSpeechPlayer'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import CustomSelect from '../shared/CustomSelect.vue'
import BaseCard from '../shared/BaseCard.vue'
import ModalDialog from '../shared/ModalDialog.vue'
import type { SelectOptionGroup } from '../shared/CustomSelect.vue'
import SettingsSubheading from './SettingsSubheading.vue'

const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})

const voice = useVoiceOutputStore()
const cyno = useCynoStore()
const player = useSpeechPlayer()
const actionError = ref('')

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

function showAnySection(ids: string[]): boolean {
  return ids.some(showSection)
}

const autoReadOptions: { value: VoiceAutoRead; label: string; tooltip: string; iconName: string }[] = [
  { value: 'voice', label: 'When I use voice', tooltip: 'Replies to messages you dictated are read aloud as they stream.', iconName: 'lucide:mic' },
  { value: 'always', label: 'Always', tooltip: 'Every reply in the open chat is read aloud.', iconName: 'lucide:volume-2' },
  { value: 'off', label: 'Off', tooltip: 'Only the speaker button on a message reads it aloud.', iconName: 'lucide:volume-x' },
]

const autoReadGroups = computed<SelectOptionGroup[]>(() => [{ label: 'Read replies aloud', options: autoReadOptions }])

function voiceTitle(entry: PiperVoice): string {
  return entry.name.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function qualityLabel(quality: PiperVoice['quality']): string {
  return { x_low: 'Very low', low: 'Low', medium: 'Medium', high: 'High' }[quality]
}

function languageLabel(entry: PiperVoice): string {
  return entry.countryName ? `${entry.languageName} (${entry.countryName})` : entry.languageName || entry.languageCode
}

const installedGroups = computed<SelectOptionGroup[]>(() => {
  const groups = new Map<string, SelectOptionGroup>()
  for (const entry of voice.installedVoices) {
    const label = languageLabel(entry)
    if (!groups.has(label)) groups.set(label, { label, options: [] })
    groups.get(label)!.options.push({
      value: entry.id,
      label: `${voiceTitle(entry)} · ${qualityLabel(entry.quality)}`,
      iconName: 'lucide:audio-lines',
    })
  }
  return [...groups.values()]
})

const speakerGroups = computed<SelectOptionGroup[]>(() => [{
  label: 'Speaker',
  options: Array.from({ length: voice.selectedVoice?.numSpeakers ?? 1 }, (_, index) => ({
    value: String(index),
    label: `Speaker ${index + 1}`,
    iconName: 'lucide:user-round',
  })),
}])

const speed = ref(1)
watch(() => voice.settings?.speed, (value) => { speed.value = value ?? 1 }, { immediate: true })

async function save(changes: Parameters<typeof voice.update>[0]): Promise<void> {
  actionError.value = ''
  try {
    await voice.update(changes)
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  }
}

const sampleTexts: Record<string, (name: string) => string> = {
  en: (name) => `Hello, I'm ${name}. This is how I sound when I read my replies to you.`,
  de: (name) => `Hallo, ich bin ${name}. So klinge ich, wenn ich dir meine Antworten vorlese.`,
  fr: (name) => `Bonjour, je suis ${name}. Voici ma voix quand je te lis mes réponses.`,
  es: (name) => `Hola, soy ${name}. Así sueno cuando te leo mis respuestas.`,
  it: (name) => `Ciao, sono ${name}. Ecco come suono quando ti leggo le mie risposte.`,
  nl: (name) => `Hallo, ik ben ${name}. Zo klink ik als ik mijn antwoorden voorlees.`,
}

const testing = computed(() => player.isSpeaking('voice-test'))

function testVoice(): void {
  if (testing.value) {
    player.stop()
    return
  }
  const family = voice.selectedVoice?.languageCode.split('_')[0] ?? 'en'
  player.speak('voice-test', (sampleTexts[family] ?? sampleTexts.en)(cyno.name), { speed: speed.value })
}

// ── Voice library ──────────────────────────
const libraryLanguage = ref('')
const languageGroups = computed<SelectOptionGroup[]>(() => {
  const languages = new Map<string, string>()
  for (const entry of voice.voices) languages.set(entry.languageCode, languageLabel(entry))
  return [{
    label: 'Language',
    options: [...languages.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label, iconName: 'lucide:languages' })),
  }]
})

/** Start the library at the browser's language, falling back to English. */
watch(() => voice.voices.length, () => {
  if (libraryLanguage.value || !voice.voices.length) return
  const available = new Set(voice.voices.map((entry) => entry.languageCode))
  const preferred = [...navigator.languages, 'en-GB', 'en-US']
    .map((tag) => tag.replace('-', '_'))
    .flatMap((tag) => [tag, ...[...available].filter((code) => code.split('_')[0] === tag.split('_')[0])])
  libraryLanguage.value = preferred.find((code) => available.has(code)) ?? voice.voices[0].languageCode
}, { immediate: true })

const libraryVoices = computed(() => voice.voices.filter((entry) => entry.languageCode === libraryLanguage.value))

function formatSize(bytes: number): string {
  return bytes ? `${Math.round(bytes / 1_000_000)} MB` : ''
}

function downloadPercent(voiceId: string): number {
  const download = voice.downloads[voiceId]
  return download?.total ? Math.round((download.loaded / download.total) * 100) : 0
}

async function download(voiceId: string): Promise<void> {
  actionError.value = ''
  try {
    await voice.download(voiceId)
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  }
}

const voiceToDelete = ref<PiperVoice | null>(null)
const deleting = ref(false)
const deleteError = ref('')
/** The voice Cyno switches to when the active one is deleted. */
const replacementVoice = computed(() => voiceToDelete.value?.id === voice.settings?.voiceId
  ? voice.installedVoices.find((entry) => entry.id !== voiceToDelete.value?.id) ?? null
  : null)

function askDelete(entry: PiperVoice): void {
  deleteError.value = ''
  voiceToDelete.value = entry
}

async function confirmDelete(): Promise<void> {
  if (!voiceToDelete.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    if (player.state.key === 'voice-test') player.stop()
    await voice.remove(voiceToDelete.value.id)
    voiceToDelete.value = null
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : String(err)
  } finally {
    deleting.value = false
  }
}

// Samples are Piper's own recordings, so a voice can be heard before downloading it.
const sampleAudio = new Audio()
const playingSample = ref('')
sampleAudio.addEventListener('ended', () => { playingSample.value = '' })
sampleAudio.addEventListener('error', () => { playingSample.value = '' })

function toggleSample(entry: PiperVoice): void {
  if (playingSample.value === entry.id) {
    sampleAudio.pause()
    playingSample.value = ''
    return
  }
  const family = entry.languageCode.split('_')[0]
  sampleAudio.src = `https://rhasspy.github.io/piper-samples/samples/${family}/${entry.languageCode}/${entry.name}/${entry.quality}/speaker_0.mp3`
  playingSample.value = entry.id
  sampleAudio.play().catch(() => { playingSample.value = '' })
}

onMounted(() => {
  if (!voice.settings) void voice.load()
  voice.loadVoices().catch((err: unknown) => {
    actionError.value = err instanceof Error ? err.message : String(err)
  })
})

onBeforeUnmount(() => {
  sampleAudio.pause()
  if (testing.value) player.stop()
})
</script>

<template>
  <div class="space-y-4">
    <SettingsSubheading
      v-if="showAnySection(['voice-output', 'voice-output-voice'])"
      label="Speech"
    />

    <div
      v-if="actionError"
      class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-status-danger"
    >
      {{ actionError }}
    </div>

    <!-- Speak replies -->
    <BaseCard
      v-if="showSection('voice-output') && voice.settings"
      class="p-5 space-y-4"
    >
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
            <Icon
              icon="lucide:volume-2"
              class="w-5 h-5 text-ink-secondary"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Speak Replies
            </h3>
            <p class="text-xs text-ink-muted mt-0.5">
              Show a read-aloud button on replies and let {{ cyno.name }} answer out loud
            </p>
          </div>
        </div>
        <ToggleSwitch
          :model-value="voice.settings.enabled"
          label="Speak replies"
          @update:model-value="save({ enabled: $event })"
        />
      </div>

      <div
        v-if="voice.settings.enabled"
        class="space-y-1.5"
      >
        <label class="text-[11px] font-medium text-ink-muted uppercase tracking-wider">Read replies aloud</label>
        <CustomSelect
          :model-value="voice.settings.autoRead"
          :groups="autoReadGroups"
          placeholder="Choose when to read aloud..."
          @update:model-value="save({ autoRead: $event as VoiceAutoRead })"
        />
        <p class="text-xs text-ink-muted">
          Speaking into the microphone or pressing Esc stops {{ cyno.name }} mid-sentence.
        </p>
      </div>
    </BaseCard>

    <!-- Voice -->
    <BaseCard
      v-if="showSection('voice-output-voice') && voice.settings?.enabled"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:audio-lines"
            class="w-5 h-5 text-ink-secondary"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            {{ cyno.name }}'s Voice
          </h3>
          <p class="text-xs text-ink-muted mt-0.5">
            Piper voices run on the Cynosure server, so every device and channel sounds the same
          </p>
        </div>
      </div>

      <div
        v-if="!voice.installedVoices.length"
        class="rounded-lg bg-theme-800/60 border border-theme-700/50 p-3"
      >
        <div class="flex items-center gap-2 text-xs">
          <Icon
            icon="lucide:info"
            class="w-3.5 h-3.5 text-accent-fg shrink-0"
          />
          <span class="text-ink-secondary">
            No voice installed yet. Listen to a few in the voice library below and download one you like.
          </span>
        </div>
      </div>

      <template v-else>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium text-ink-muted uppercase tracking-wider">Voice</label>
            <CustomSelect
              :model-value="voice.settings?.voiceId ?? ''"
              :groups="installedGroups"
              placeholder="Choose a voice..."
              @update:model-value="save({ voiceId: $event, speakerId: 0 })"
            />
          </div>
          <div
            v-if="(voice.selectedVoice?.numSpeakers ?? 1) > 1"
            class="space-y-1.5"
          >
            <label class="text-[11px] font-medium text-ink-muted uppercase tracking-wider">Speaker</label>
            <CustomSelect
              :model-value="String(voice.settings?.speakerId ?? 0)"
              :groups="speakerGroups"
              placeholder="Choose a speaker..."
              max-height="max-h-64"
              @update:model-value="save({ speakerId: Number($event) })"
            />
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label
              for="voice-speed"
              class="text-[11px] font-medium text-ink-muted uppercase tracking-wider"
            >Speed</label>
            <span class="text-xs text-theme-300 tabular-nums">{{ speed.toFixed(2) }}×</span>
          </div>
          <input
            id="voice-speed"
            v-model.number="speed"
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            class="h-2 w-full cursor-pointer accent-accent-500"
            @change="save({ speed })"
          >
        </div>

        <button
          :disabled="!voice.settings?.voiceId"
          class="px-4 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:opacity-50 disabled:cursor-not-allowed accent-action bg-accent-600 hover:bg-accent-500 text-accent-on"
          @click="testVoice"
        >
          <Icon
            :icon="testing ? 'lucide:square' : 'lucide:play'"
            class="w-4 h-4 inline-block mr-1.5 -mt-0.5"
          />
          {{ testing ? 'Stop' : 'Test Voice' }}
        </button>
      </template>
    </BaseCard>

    <SettingsSubheading
      v-if="showSection('voice-library') && voice.settings?.enabled"
      label="Voice Library"
    />

    <!-- Voice library -->
    <BaseCard
      v-if="showSection('voice-library') && voice.settings?.enabled"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:library"
            class="w-5 h-5 text-ink-secondary"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Piper Voices
          </h3>
          <p class="text-xs text-ink-muted mt-0.5">
            Free, offline voices. Medium quality is a good balance of sound and size.
          </p>
        </div>
      </div>

      <div
        v-if="voice.catalogError"
        class="rounded-lg bg-theme-800/60 border border-theme-700/50 p-3 text-xs text-ink-secondary flex items-center gap-2"
      >
        <Icon
          icon="lucide:wifi-off"
          class="w-3.5 h-3.5 text-status-warning shrink-0"
        />
        {{ voice.catalogError }}
      </div>

      <CustomSelect
        v-if="voice.voices.length"
        v-model="libraryLanguage"
        :groups="languageGroups"
        placeholder="Choose a language..."
        filterable
        max-height="max-h-72"
      />

      <div
        v-if="voice.voicesLoading && !voice.voices.length"
        class="text-xs text-ink-muted"
      >
        Loading voices…
      </div>

      <ul class="space-y-2">
        <li
          v-for="entry in libraryVoices"
          :key="entry.id"
          class="rounded-lg bg-theme-800/60 border border-theme-700/40 px-3 py-2"
        >
          <div class="flex items-center gap-3">
            <button
              class="p-1.5 rounded-md text-ink-muted hover:text-theme-100 hover:bg-theme-700/60 transition-colors shrink-0"
              :title="playingSample === entry.id ? 'Stop sample' : 'Play sample'"
              :aria-label="`${playingSample === entry.id ? 'Stop' : 'Play'} sample of ${voiceTitle(entry)}`"
              @click="toggleSample(entry)"
            >
              <Icon
                :icon="playingSample === entry.id ? 'lucide:square' : 'lucide:play'"
                class="w-3.5 h-3.5"
              />
            </button>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm text-theme-200 truncate">{{ voiceTitle(entry) }}</span>
                <span class="text-[10px] text-ink-muted bg-theme-700/60 px-1.5 py-0.5 rounded uppercase">{{ qualityLabel(entry.quality) }}</span>
                <span
                  v-if="entry.id === voice.settings?.voiceId"
                  class="text-[10px] text-accent-fg font-medium"
                >active</span>
              </div>
              <div class="text-[11px] text-ink-muted">
                {{ entry.numSpeakers > 1 ? `${entry.numSpeakers} speakers · ` : '' }}{{ formatSize(entry.sizeBytes) }}
              </div>
            </div>

            <template v-if="voice.downloads[entry.id]?.status === 'downloading'">
              <span class="text-[11px] text-ink-muted tabular-nums">{{ downloadPercent(entry.id) }}%</span>
            </template>
            <template v-else-if="entry.installed">
              <Icon
                icon="lucide:check-circle-2"
                class="w-4 h-4 text-status-green shrink-0"
                aria-label="Installed"
              />
              <button
                class="p-1.5 rounded-md text-ink-muted hover:text-status-danger hover:bg-theme-700/60 transition-colors"
                :title="`Delete ${voiceTitle(entry)}`"
                :aria-label="`Delete ${voiceTitle(entry)}`"
                @click="askDelete(entry)"
              >
                <Icon
                  icon="lucide:trash-2"
                  class="w-3.5 h-3.5"
                />
              </button>
            </template>
            <button
              v-else
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary hover:text-theme-200 bg-theme-800 hover:bg-theme-700 border border-theme-700 transition-colors"
              @click="download(entry.id)"
            >
              <Icon
                icon="lucide:download"
                class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5"
              />
              Download
            </button>
          </div>
          <div
            v-if="voice.downloads[entry.id]?.status === 'downloading'"
            class="mt-2 w-full bg-theme-800 rounded-full h-1.5 overflow-hidden"
          >
            <div
              class="h-full rounded-full bg-accent-500 transition-all duration-300"
              :style="{ width: `${downloadPercent(entry.id)}%` }"
            />
          </div>
          <p
            v-if="voice.downloads[entry.id]?.status === 'error'"
            class="mt-1 text-[11px] text-status-danger"
          >
            {{ voice.downloads[entry.id]?.error }}
          </p>
        </li>
      </ul>
    </BaseCard>

    <ModalDialog
      :show="voiceToDelete !== null"
      title="Delete voice?"
      icon="lucide:trash-2"
      icon-color="red"
      layer="nested"
      @close="voiceToDelete = null"
    >
      <p class="text-sm leading-relaxed text-ink-secondary">
        <span class="font-medium text-theme-100">{{ voiceToDelete ? voiceTitle(voiceToDelete) : '' }}</span>
        ({{ voiceToDelete ? formatSize(voiceToDelete.sizeBytes) : '' }}) will be removed from the server. You can download it again from the voice library.
      </p>
      <p
        v-if="voiceToDelete?.id === voice.settings?.voiceId"
        class="mt-3 text-sm leading-relaxed text-ink-secondary"
      >
        <template v-if="replacementVoice">
          {{ cyno.name }} will speak with <span class="font-medium text-theme-100">{{ voiceTitle(replacementVoice) }}</span> instead.
        </template>
        <template v-else>
          It is the only installed voice, so {{ cyno.name }} will stop speaking until you download another.
        </template>
      </p>
      <p
        v-if="deleteError"
        class="mt-3 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-status-danger"
        role="alert"
      >
        {{ deleteError }}
      </p>
      <template #actions>
        <button
          type="button"
          class="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-60"
          :disabled="deleting"
          data-testid="confirm-delete-voice"
          @click="confirmDelete"
        >
          {{ deleting ? 'Deleting…' : 'Delete voice' }}
        </button>
        <button
          type="button"
          class="w-full rounded-xl bg-theme-800 px-4 py-3 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
          :disabled="deleting"
          @click="voiceToDelete = null"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
