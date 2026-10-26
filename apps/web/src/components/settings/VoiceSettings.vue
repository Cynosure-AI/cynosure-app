<script setup lang="ts">
import SpeechToTextSettings from './SpeechToTextSettings.vue'
import TextToSpeechSettings from './TextToSpeechSettings.vue'

withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})
</script>

<template>
  <div class="space-y-4">
    <SpeechToTextSettings :visible-sections="visibleSections" />
    <TextToSpeechSettings :visible-sections="visibleSections" />
  </div>
</template>
