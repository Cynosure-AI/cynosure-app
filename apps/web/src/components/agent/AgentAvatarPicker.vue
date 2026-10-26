<script setup lang="ts">
/**
 * Picks which face an assistant shows. Each tab previews its option and
 * choosing a tab makes it the active source; the panel below configures it.
 * The other option keeps its settings, so switching back loses nothing.
 */
import { Icon } from '@iconify/vue'
import type { AvatarSource } from '@shared/types'
import AgentAvatar from '../shared/AgentAvatar.vue'
import IconUpload from '../shared/IconUpload.vue'
import AgentAvatarEditor from './AgentAvatarEditor.vue'
import type { AvatarConfig } from '../../utils/avatar'

const props = defineProps<{
  name: string
  avatarSource: AvatarSource
  avatar: AvatarConfig | null
  imageUrl: string | null
  defaultAvatar?: AvatarConfig | null
}>()

const emit = defineEmits<{ update: [field: 'avatarSource' | 'avatar' | 'imageUrl', value: unknown] }>()

const TABS: Array<{ source: AvatarSource; label: string; hint: string }> = [
  { source: 'generated', label: 'Generated', hint: 'Animated, reacts while it works' },
  { source: 'image', label: 'Image', hint: 'Your own picture' },
]

function select(source: AvatarSource): void {
  if (source !== props.avatarSource) emit('update', 'avatarSource', source)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const next = props.avatarSource === 'generated' ? 'image' : 'generated'
  select(next)
  ;(event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-source="${next}"]`)?.focus()
}
</script>

<template>
  <div>
    <span class="mb-1.5 block text-sm text-ink-secondary">Avatar</span>
    <p class="mb-3 text-xs text-ink-faint">
      Shown wherever {{ name || 'this assistant' }} appears. The option you pick is the one in use.
    </p>

    <div
      class="grid grid-cols-2 gap-2"
      role="tablist"
      aria-label="Avatar source"
    >
      <button
        v-for="tab in TABS"
        :key="tab.source"
        type="button"
        role="tab"
        :data-source="tab.source"
        :aria-selected="avatarSource === tab.source"
        :tabindex="avatarSource === tab.source ? 0 : -1"
        class="relative flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors"
        :class="avatarSource === tab.source
          ? 'border-accent-500 bg-accent-500/10'
          : 'border-theme-700 bg-theme-900/50 hover:border-theme-500'"
        @click="select(tab.source)"
        @keydown="onKeydown"
      >
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg"
          :class="tab.source === 'image' ? 'border border-theme-700 bg-theme-800' : ''"
        >
          <AgentAvatar
            v-if="tab.source === 'generated'"
            :name="name"
            :avatar="avatar"
          />
          <img
            v-else-if="imageUrl"
            :src="imageUrl"
            alt=""
            class="h-full w-full object-cover"
          >
          <Icon
            v-else
            icon="lucide:image-plus"
            class="h-5 w-5 text-ink-muted"
          />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium text-theme-200">{{ tab.label }}</span>
          <span class="block truncate text-[11px] text-ink-muted">{{ tab.hint }}</span>
        </span>
        <span
          class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
          :class="avatarSource === tab.source ? 'border-accent-500 bg-accent-500 text-white' : 'border-theme-600'"
          aria-hidden="true"
        >
          <Icon
            v-if="avatarSource === tab.source"
            icon="lucide:check"
            class="h-3 w-3"
          />
        </span>
      </button>
    </div>

    <div
      class="mt-4"
      role="tabpanel"
      :aria-label="avatarSource === 'generated' ? 'Generated avatar settings' : 'Image settings'"
    >
      <AgentAvatarEditor
        v-if="avatarSource === 'generated'"
        :name="name"
        :avatar="avatar"
        :default-avatar="defaultAvatar"
        @update="emit('update', 'avatar', $event)"
      />
      <template v-else>
        <IconUpload
          :icon-url="imageUrl"
          label="Image"
          @update="emit('update', 'imageUrl', $event)"
        >
          <template #description>
            Images up to 5 MB are cropped and optimized to 512 × 512. Animated GIFs up to 1.5 MB are kept as they are, so they keep playing.
          </template>
        </IconUpload>
        <p
          v-if="!imageUrl"
          class="mt-2 text-xs text-ink-muted"
        >
          Until an image is uploaded, the generated avatar is shown.
        </p>
      </template>
    </div>
  </div>
</template>
