<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import { api } from '../../../api/client'
import type { ImageGenerationModelInfo, VideoGenerationModelInfo } from '../../../api/types'
import type { MediaGenerationSettings } from '@shared/types'

const props = defineProps<{
  kind: 'image' | 'video'
  providerId: string
  model: string
  value: MediaGenerationSettings | null
}>()
const emit = defineEmits<{ change: [value: MediaGenerationSettings | null] }>()
const root = ref<HTMLElement | null>(null)
const open = ref(false)
const loading = ref(false)
const videoModel = ref<VideoGenerationModelInfo | null>(null)
const imageModel = ref<ImageGenerationModelInfo | null>(null)

const hasSettings = computed(() => Boolean(props.value && Object.keys(props.value).some((key) => key !== 'kind')))
const videoResolutions = computed(() => videoModel.value?.supported_resolutions?.length
  ? videoModel.value.supported_resolutions : ['480p', '720p', '768p', '1080p', '1K', '2K', '4K'])
const videoRatios = computed(() => videoModel.value?.supported_aspect_ratios?.length
  ? videoModel.value.supported_aspect_ratios : ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21'])
const imageResolutions = computed(() => imageModel.value?.supported_parameters
  ? (imageModel.value.supported_parameters.resolution?.values || []) : ['512', '1K', '2K', '4K'])
const imageRatios = computed(() => imageModel.value?.supported_parameters
  ? (imageModel.value.supported_parameters.aspect_ratio?.values || [])
  : ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'])
const imageCount = computed(() => imageModel.value?.supported_parameters?.n)
const imageCountOptions = computed(() => {
  const descriptor = imageCount.value
  if (!descriptor && imageModel.value?.supported_parameters) return []
  const min = Math.max(1, Math.ceil(descriptor?.min ?? 1))
  const max = Math.min(10, Math.floor(descriptor?.max ?? 10))
  return Array.from({ length: Math.max(0, max - min + 1) }, (_, index) => min + index)
})
const frameOptions = computed(() => {
  const supported = videoModel.value?.supported_frame_images
  return [
    ...(supported == null || supported.includes('first_frame') ? [{ value: 'first', label: 'First frame' }] : []),
    ...(supported == null || supported.includes('last_frame') ? [{ value: 'last', label: 'Last frame' }] : []),
    ...(supported == null || (supported.includes('first_frame') && supported.includes('last_frame'))
      ? [{ value: 'first_last', label: 'First and last frames' }] : []),
    { value: 'reference', label: 'Style references' },
  ]
})

watch(() => [props.kind, props.providerId, props.model] as const, async (_next, _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  videoModel.value = null
  imageModel.value = null
  if (!props.providerId || !props.model) return
  loading.value = true
  try {
    if (props.kind === 'video') {
      const models = await api.provider.listVideoModels(props.providerId)
      if (!cancelled) videoModel.value = models.find((item) => item.id === props.model || item.canonical_slug === props.model) || null
    } else {
      const models = await api.provider.listImageGenerationModels(props.providerId)
      if (!cancelled) imageModel.value = models.find((item) => item.id === props.model) || null
    }
  } catch {
    // Server validation still checks any manually selected fallback values.
  } finally {
    if (!cancelled) loading.value = false
  }
}, { immediate: true })

function update(key: keyof MediaGenerationSettings, value: string | number | boolean | undefined): void {
  const next: Record<string, unknown> = { ...(props.value || { kind: props.kind }) }
  if (value === undefined || value === '') delete next[key]
  else next[key] = value
  emit('change', Object.keys(next).length === 1 ? null : next as unknown as MediaGenerationSettings)
}

function reset(): void { emit('change', null) }
onClickOutside(root, () => { open.value = false })
</script>

<template>
  <div
    ref="root"
    class="relative shrink-0"
  >
    <button
      type="button"
      class="relative flex h-8 w-8 items-center justify-center rounded-full border border-theme-700 text-accent-300 transition-colors hover:border-theme-500 hover:bg-theme-700 hover:text-theme-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      :aria-label="`${kind === 'video' ? 'Video' : 'Image'} generation settings`"
      :aria-expanded="open"
      :title="`${kind === 'video' ? 'Video' : 'Image'} generation settings`"
      @click="open = !open"
    >
      <Icon
        :icon="kind === 'video' ? 'lucide:video' : 'lucide:image'"
        class="h-4 w-4"
      />      <span
        v-if="hasSettings"
        class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-500"
      />
    </button>

    <div
      v-if="open"
      class="absolute bottom-full left-0 z-50 mb-2 w-[min(20rem,calc(100vw-2rem))] max-h-[65vh] overflow-y-auto rounded-xl border border-theme-700 bg-theme-800 p-3 shadow-2xl shadow-black/50"
      role="group"
      :aria-label="`${kind === 'video' ? 'Video' : 'Image'} generation settings`"
      @keydown.esc="open = false"
    >
      <div class="mb-3 flex items-center justify-between gap-2">
        <h3 class="text-sm font-medium text-theme-100">
          {{ kind === 'video' ? 'Video' : 'Image' }} settings
        </h3>
        <button
          type="button"
          class="text-xs text-theme-400 hover:text-theme-100"
          @click="reset"
        >
          Reset
        </button>
      </div>
      <p
        v-if="loading"
        class="mb-2 text-xs text-theme-500"
      >
        Loading model options…
      </p>
      <div class="grid gap-3 text-xs">
        <label class="grid gap-1 text-theme-300">
          Resolution
          <select
            :value="value?.resolution || ''"
            class="rounded-md border border-theme-600 bg-theme-900 px-2 py-1.5 text-theme-100"
            :disabled="kind === 'image' && !imageResolutions.length"
            @change="update('resolution', ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Default</option>
            <option
              v-for="resolution in kind === 'video' ? videoResolutions : imageResolutions"
              :key="resolution"
              :value="resolution"
            >{{ resolution }}</option>
          </select>
        </label>
        <label class="grid gap-1 text-theme-300">
          Aspect ratio
          <select
            :value="value?.aspect_ratio || ''"
            class="rounded-md border border-theme-600 bg-theme-900 px-2 py-1.5 text-theme-100"
            :disabled="kind === 'image' && !imageRatios.length"
            @change="update('aspect_ratio', ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Default</option>
            <option
              v-for="ratio in kind === 'video' ? videoRatios : imageRatios"
              :key="ratio"
              :value="ratio"
            >{{ ratio }}</option>
          </select>
        </label>

        <template v-if="kind === 'image'">
          <label class="grid gap-1 text-theme-300">
            Images per call
            <select
              :value="value?.n ?? ''"
              class="rounded-md border border-theme-600 bg-theme-900 px-2 py-1.5 text-theme-100"
              :disabled="!imageCountOptions.length"
              @change="update('n', ($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : undefined)"
            >
              <option value="">Default</option>
              <option
                v-for="count in imageCountOptions"
                :key="count"
                :value="count"
              >{{ count }}</option>
            </select>
          </label>
        </template>

        <template v-else>
          <label class="grid gap-1 text-theme-300">
            Duration (seconds)
            <select
              v-if="videoModel?.supported_durations?.length"
              :value="value?.duration ?? ''"
              class="rounded-md border border-theme-600 bg-theme-900 px-2 py-1.5 text-theme-100"
              @change="update('duration', ($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : undefined)"
            >
              <option value="">Default</option>
              <option
                v-for="duration in videoModel.supported_durations"
                :key="duration"
                :value="duration"
              >{{ duration }}s</option>
            </select>
            <input
              v-else
              type="number"
              min="1"
              step="1"
              :value="value?.duration ?? ''"
              placeholder="Default"
              class="rounded-md border border-theme-600 bg-theme-900 px-2 py-1.5 text-theme-100"
              @change="update('duration', ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : undefined)"
            >
          </label>
          <label class="grid gap-1 text-theme-300">
            Audio
            <select
              :value="value?.generate_audio == null ? '' : String(value.generate_audio)"
              class="rounded-md border border-theme-600 bg-theme-900 px-2 py-1.5 text-theme-100"
              @change="update('generate_audio', ($event.target as HTMLSelectElement).value === '' ? undefined : ($event.target as HTMLSelectElement).value === 'true')"
            >
              <option value="">Default</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </label>
          <label class="grid gap-1 text-theme-300">
            Attached images
            <select
              :value="value?.frame_mode || ''"
              class="rounded-md border border-theme-600 bg-theme-900 px-2 py-1.5 text-theme-100"
              @change="update('frame_mode', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Automatic</option>
              <option
                v-for="option in frameOptions"
                :key="option.value"
                :value="option.value"
              >{{ option.label }}</option>
            </select>
          </label>
          <p class="text-theme-500">
            For first and last frames, attach two images in that order.
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
