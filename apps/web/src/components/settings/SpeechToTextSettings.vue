<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useWhisper } from '../../composables/useWhisper'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import CustomSelect from '../shared/CustomSelect.vue'
import BaseCard from '../shared/BaseCard.vue'
import type { SelectOptionGroup } from '../shared/CustomSelect.vue'

const prefs = usePreferencesStore()
const { status, progress, fileProgress, downloadedModels, errorMessage, loadModel, clearDownloadedModels, dispose } = useWhisper()
const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

const whisperModels: { id: string; label: string; size: string; description: string }[] = [
  { id: 'onnx-community/whisper-tiny', label: 'Whisper Tiny', size: '~75 MB', description: 'Fastest, lower accuracy' },
  { id: 'onnx-community/whisper-base', label: 'Whisper Base', size: '~140 MB', description: 'Good balance of speed and accuracy' },
  { id: 'onnx-community/whisper-small', label: 'Whisper Small', size: '~460 MB', description: 'Better accuracy, slower download' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', size: '~800 MB', description: 'Best accuracy, optimised large model' },
]

const quantizationOptions: { id: string; label: string; description: string }[] = [
  { id: 'q4', label: 'Q4 (4-bit)', description: 'Smallest size, fastest, slightly lower quality' },
  { id: 'q8', label: 'Q8 (8-bit)', description: 'Good balance of size and quality (recommended)' },
  { id: 'fp16', label: 'FP16 (16-bit)', description: 'High quality, larger download' },
  { id: 'fp32', label: 'FP32 (32-bit)', description: 'Full precision, largest download' },
]

const modelGroups = computed<SelectOptionGroup[]>(() => [{
  label: 'Whisper Models (Multilingual)',
  options: whisperModels.map(m => ({
    value: m.id,
    label: `${m.label}  (${m.size})`,
    tooltip: m.description,
    iconName: 'lucide:audio-waveform',
  })),
}])

const quantizationGroups = computed<SelectOptionGroup[]>(() => [{
  label: 'Quantization',
  options: quantizationOptions.map(q => ({
    value: q.id,
    label: q.label,
    tooltip: q.description,
    iconName: 'lucide:gauge',
  })),
}])

const languages: { id: string; label: string }[] = [
  { id: 'english', label: 'English' },
  { id: 'german', label: 'German' },
  { id: 'french', label: 'French' },
  { id: 'spanish', label: 'Spanish' },
  { id: 'italian', label: 'Italian' },
  { id: 'portuguese', label: 'Portuguese' },
  { id: 'dutch', label: 'Dutch' },
  { id: 'polish', label: 'Polish' },
  { id: 'russian', label: 'Russian' },
  { id: 'chinese', label: 'Chinese' },
  { id: 'japanese', label: 'Japanese' },
  { id: 'korean', label: 'Korean' },
  { id: 'arabic', label: 'Arabic' },
  { id: 'hindi', label: 'Hindi' },
  { id: 'turkish', label: 'Turkish' },
  { id: 'swedish', label: 'Swedish' },
  { id: 'danish', label: 'Danish' },
  { id: 'norwegian', label: 'Norwegian' },
  { id: 'finnish', label: 'Finnish' },
  { id: 'czech', label: 'Czech' },
  { id: 'romanian', label: 'Romanian' },
  { id: 'hungarian', label: 'Hungarian' },
  { id: 'greek', label: 'Greek' },
  { id: 'ukrainian', label: 'Ukrainian' },
  { id: 'indonesian', label: 'Indonesian' },
  { id: 'vietnamese', label: 'Vietnamese' },
  { id: 'thai', label: 'Thai' },
  { id: 'hebrew', label: 'Hebrew' },
  { id: 'catalan', label: 'Catalan' },
  { id: 'malay', label: 'Malay' },
]

const languageGroups = computed<SelectOptionGroup[]>(() => [{
  label: 'Languages',
  options: languages.map(l => ({
    value: l.id,
    label: l.label,
    iconName: 'lucide:languages',
  })),
}])

function downloadModel(): void {
  loadModel(prefs.whisperModel)
}

function deleteCache(): void {
  if ('caches' in window) {
    caches.keys().then(names => {
      for (const name of names) {
        if (name.includes('transformers')) {
          caches.delete(name)
        }
      }
    })
  }
  indexedDB.databases().then(dbs => {
    for (const db of dbs) {
      if (db.name && (db.name.includes('transformers') || db.name.includes('onnx'))) {
        indexedDB.deleteDatabase(db.name)
      }
    }
  })
  clearDownloadedModels()
  dispose()
}

const isModelReady = computed(() => status.value === 'ready')
const isLoading = computed(() => status.value === 'loading')
const selectedModelInfo = computed(() => whisperModels.find(m => m.id === prefs.whisperModel))

const fileEntries = computed(() =>
  Object.entries(fileProgress.value).map(([file, p]) => ({
    name: file.split('/').pop() || file,
    file,
    ...p,
  }))
)

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function modelLabel(modelId: string): string {
  return whisperModels.find(m => m.id === modelId)?.label ?? modelId
}

interface MicDevice { deviceId: string; label: string }
const micDevices = ref<MicDevice[]>([])

async function enumerateMics(): Promise<void> {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true })
    const devices = await navigator.mediaDevices.enumerateDevices()
    micDevices.value = devices
      .filter(d => d.kind === 'audioinput')
      .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${micDevices.value.length + 1}` }))
  } catch {
    micDevices.value = []
  }
}

const micDeviceGroups = computed<SelectOptionGroup[]>(() => [{
  label: 'Input Device',
  options: [
    { value: '', label: 'Default', iconName: 'lucide:mic' },
    ...micDevices.value.map(d => ({
      value: d.deviceId,
      label: d.label,
      iconName: 'lucide:mic',
    })),
  ],
}])

onMounted(() => {
  if (prefs.whisperEnabled) enumerateMics()
})
</script>

<template>
  <div class="space-y-4">
    <!-- Enable/Disable -->
    <BaseCard
      v-if="showSection('enable-voice')"
      class="p-5"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
            <Icon
              icon="lucide:mic"
              class="w-5 h-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Enable Voice Input
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Show microphone button in the chat input bar
            </p>
          </div>
        </div>
        <ToggleSwitch v-model="prefs.whisperEnabled" />
      </div>
    </BaseCard>

    <!-- Model & Quantization -->
    <BaseCard
      v-if="showSection('voice-model')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:brain-circuit"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Model &amp; Quantization
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            All models support 99 languages including English and German
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="text-[11px] font-medium text-theme-500 uppercase tracking-wider">Model</label>
          <CustomSelect
            v-model="prefs.whisperModel"
            :groups="modelGroups"
            placeholder="Select a model..."
          />
        </div>
        <div class="space-y-1.5">
          <label class="text-[11px] font-medium text-theme-500 uppercase tracking-wider">Quantization</label>
          <CustomSelect
            v-model="prefs.whisperQuantization"
            :groups="quantizationGroups"
            placeholder="Select quantization..."
          />
        </div>
      </div>

      <div
        v-if="selectedModelInfo"
        class="rounded-lg bg-theme-800/60 border border-theme-700/50 p-3"
      >
        <div class="flex items-center gap-2 text-xs">
          <Icon
            icon="lucide:info"
            class="w-3.5 h-3.5 text-accent-400 shrink-0"
          />
          <span class="text-theme-400">
            <span class="text-theme-300 font-medium">{{ selectedModelInfo.label }}</span>
            - {{ selectedModelInfo.description }}.
            Download size: <span class="text-theme-300">{{ selectedModelInfo.size }}</span>.
            Cached in browser after first download.
          </span>
        </div>
      </div>
    </BaseCard>

    <!-- Language -->
    <BaseCard
      v-if="showSection('voice-language')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:languages"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Language
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Language used for speech recognition
          </p>
        </div>
      </div>

      <CustomSelect
        v-model="prefs.whisperLanguage"
        :groups="languageGroups"
        placeholder="Select language..."
      />
    </BaseCard>

    <!-- Microphone -->
    <BaseCard
      v-if="showSection('microphone')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:mic"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Microphone
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Select which microphone to use for voice input
          </p>
        </div>
      </div>

      <CustomSelect
        v-model="prefs.whisperMicDeviceId"
        :groups="micDeviceGroups"
        placeholder="Select microphone..."
      />

      <div
        v-if="micDevices.length === 0"
        class="rounded-lg bg-theme-800/60 border border-theme-700/50 p-3"
      >
        <div class="flex items-center gap-2 text-xs">
          <Icon
            icon="lucide:info"
            class="w-3.5 h-3.5 text-amber-400 shrink-0"
          />
          <span class="text-theme-400">
            No microphones detected. Please allow microphone access when prompted.
          </span>
        </div>
      </div>
    </BaseCard>

    <!-- Download & Cache -->
    <BaseCard
      v-if="showSection('download-cache')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:download"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div class="flex-1">
          <h3 class="text-sm font-medium text-theme-200">
            Download &amp; Cache
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Download the model now, or it will be downloaded automatically on first use
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <div
          class="w-2 h-2 rounded-full shrink-0"
          :class="{
            'bg-theme-600': status === 'idle',
            'bg-amber-500 animate-pulse': isLoading,
            'bg-green-500': isModelReady,
            'bg-red-500': status === 'error',
          }"
        />
        <span class="text-xs text-theme-400">
          <template v-if="status === 'idle'">
            Not loaded
          </template>
          <template v-else-if="isLoading">
            Downloading... {{ progress }}% overall
          </template>
          <template v-else-if="isModelReady">
            Model ready
          </template>
          <template v-else-if="status === 'error'">
            Error: {{ errorMessage }}
          </template>
          <template v-else>
            {{ status }}
          </template>
        </span>
      </div>

      <div
        v-if="isLoading && fileEntries.length > 0"
        class="space-y-2"
      >
        <div
          v-for="entry in fileEntries"
          :key="entry.file"
          class="space-y-1"
        >
          <div class="flex items-center justify-between text-[11px]">
            <span class="text-theme-400 truncate max-w-[60%]">
              {{ entry.name }}
            </span>
            <span class="text-theme-500 tabular-nums">
              <template v-if="entry.done">
                <Icon
                  icon="lucide:check"
                  class="w-3 h-3 text-green-400 inline"
                />
              </template>
              <template v-else-if="entry.total > 0">
                {{ formatBytes(entry.loaded) }} / {{ formatBytes(entry.total) }}
              </template>
              <template v-else>
                waiting...
              </template>
            </span>
          </div>
          <div class="w-full bg-theme-800 rounded-full h-1.5 overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="entry.done ? 'bg-green-500' : 'bg-accent-500'"
              :style="{ width: `${Math.round(entry.progress)}%` }"
            />
          </div>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <button
          :disabled="isLoading"
          class="px-4 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-accent-500"
          :class="isLoading
            ? 'bg-theme-700 text-theme-500 cursor-not-allowed'
            : 'bg-accent-600 hover:bg-accent-500 text-white'"
          @click="downloadModel"
        >
          <Icon
            icon="lucide:download"
            class="w-4 h-4 inline-block mr-1.5 -mt-0.5"
          />
          {{ isModelReady ? 'Re-download' : 'Download Now' }}
        </button>
        <button
          class="px-4 py-2 rounded-lg text-sm font-medium text-theme-400 hover:text-theme-200 bg-theme-800 hover:bg-theme-700 border border-theme-700 transition-colors focus:outline-none focus:ring-1 focus:ring-theme-500"
          @click="deleteCache"
        >
          <Icon
            icon="lucide:trash-2"
            class="w-4 h-4 inline-block mr-1.5 -mt-0.5"
          />
          Clear Cache
        </button>
      </div>

      <div
        v-if="downloadedModels.length > 0"
        class="border-t border-theme-700 pt-4 space-y-2"
      >
        <h4 class="text-[11px] font-medium text-theme-500 uppercase tracking-wider">
          Cached Models
        </h4>
        <div
          v-for="dl in downloadedModels"
          :key="`${dl.model}-${dl.quantization}`"
          class="flex items-center gap-3 rounded-lg bg-theme-800/60 border border-theme-700/40 px-3 py-2"
        >
          <Icon
            icon="lucide:check-circle-2"
            class="w-4 h-4 text-green-400 shrink-0"
          />
          <span class="text-xs text-theme-300 flex-1 truncate">
            {{ modelLabel(dl.model) }}
          </span>
          <span class="text-[11px] text-theme-500 bg-theme-700/60 px-1.5 py-0.5 rounded font-mono uppercase">
            {{ dl.quantization }}
          </span>
          <span
            v-if="dl.model === prefs.whisperModel && dl.quantization === prefs.whisperQuantization"
            class="text-[10px] text-accent-400 font-medium"
          >
            active
          </span>
        </div>
      </div>
    </BaseCard>

    <!-- How it works -->
    <BaseCard
      v-if="showSection('voice-help')"
      class="p-5 space-y-3"
    >
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
          <Icon
            icon="lucide:help-circle"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <h3 class="text-sm font-medium text-theme-200">
          How it works
        </h3>
      </div>
      <div class="space-y-2 text-xs text-theme-500 pl-12">
        <p>
          <span class="text-theme-300 font-medium">100% local</span> - The Whisper model runs
          entirely in your browser using WebAssembly. No audio data leaves your device.
        </p>
        <p>
          <span class="text-theme-300 font-medium">First use</span> - The model is downloaded
          from Hugging Face Hub and cached in your browser's storage. Subsequent uses are instant.
        </p>
        <p>
          <span class="text-theme-300 font-medium">Languages</span> - Supports 99 languages
          with automatic language detection. Works well with English and German.
        </p>
        <p>
          <span class="text-theme-300 font-medium">Web Worker</span> - Transcription runs in a
          background thread so the UI stays responsive.
        </p>
      </div>
    </BaseCard>
  </div>
</template>
