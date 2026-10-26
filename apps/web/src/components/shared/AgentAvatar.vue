<script setup lang="ts">
/**
 * An assistant's face: the uploaded image when there is one, otherwise a
 * blobatar generated from its name (or its avatar config).
 *
 * Static by default, which renders a single <img>. `animate` switches to inline
 * SVG so the face can idle and morph between moods; keep that for the one or two
 * avatars a screen is about. `gaze` is read once at setup.
 */
import { computed, ref } from 'vue'
import { Blobatar } from '@blobatar/vue'
import { useGaze, type GazeTarget } from '@blobatar/vue/gaze'
import {
  happy, idle, mad, sad, shy, sick, sleepy, surprised, thinking, unsure,
} from 'blobatar/expression'
import 'blobatar/motion.css'
import 'blobatar/gaze.css'
import { blobatarProps, type AvatarConfig } from '../../utils/avatar'
import type { AgentMood } from '../../composables/useAgentMood'

const props = withDefaults(defineProps<{
  name: string
  iconUrl?: string | null
  avatar?: AvatarConfig | null
  mood?: AgentMood
  animate?: 'hover' | 'always' | false
  /** Follow the pointer. Only worth it on a large avatar; not reactive. */
  gaze?: boolean
  /** Adds a soft bob while the assistant is producing text. */
  speaking?: boolean
}>(), {
  iconUrl: null,
  avatar: null,
  mood: 'idle',
  animate: false,
  gaze: false,
  speaking: false,
})

const EXPRESSIONS = { idle, thinking, happy, sad, mad, surprised, unsure, sleepy, shy, sick } as const

const blob = ref()
const face = computed(() => blobatarProps(props.name, props.avatar))
const expression = computed(() => EXPRESSIONS[props.mood] ?? idle)

const gazeDriver = props.gaze ? useGaze(blob, { travel: 4, target: 'pointer' }) : null

defineExpose({
  lookAt: (target: GazeTarget) => gazeDriver?.lookAt(target),
})
</script>

<template>
  <img
    v-if="iconUrl"
    :src="iconUrl"
    alt=""
    class="agent-avatar h-full w-full object-cover"
  >
  <!-- The bob lives on a wrapper: blobatar's own root owns `animation` and `transform`. -->
  <span
    v-else
    class="agent-avatar agent-avatar--blob block h-full w-full"
    :class="{ 'agent-avatar--speaking': speaking }"
  >
    <Blobatar
      ref="blob"
      v-bind="face"
      :animate="animate"
      :expression="expression"
      :background="false"
      class="block h-full w-full"
      alt=""
    />
  </span>
</template>

<style scoped>
/* Livelier blinks and glances while producing text. */
.agent-avatar--speaking {
  --mo-rate: 0.6;
}

@media (prefers-reduced-motion: no-preference) {
  .agent-avatar--speaking {
    animation: agent-avatar-speak 520ms ease-in-out infinite alternate;
    transform-origin: 50% 85%;
  }
}

@keyframes agent-avatar-speak {
  from { transform: translateY(0) scale(1, 1); }
  to { transform: translateY(-4%) scale(1.03, 0.97); }
}
</style>
