<script setup lang="ts">
import { ref, watch } from 'vue'
import ModalDialog from '../../shared/ModalDialog.vue'

const props = defineProps<{
  modelValue: boolean
  systemPrompt: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:systemPrompt': [value: string]
}>()

const draft = ref('')

watch(() => props.modelValue, (open) => {
  if (open) draft.value = props.systemPrompt
})

function save(): void {
  emit('update:systemPrompt', draft.value)
  emit('update:modelValue', false)
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <ModalDialog
    :show="modelValue"
    title="System Prompt"
    icon="lucide:scroll-text"
    icon-color="accent"
    max-width="max-w-xl"
    @close="close"
  >
    <p class="text-xs text-theme-500 mb-3">
      Prepended as a system message alongside the built-in agentic instructions — does not replace them.
    </p>
    <textarea
      v-model="draft"
      placeholder="Optional system instructions..."
      rows="20"
      class="w-full bg-theme-800 border border-theme-700 rounded-lg px-3 py-2 text-sm text-theme-100 font-mono resize-y focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
    />

    <template #actions>
      <div class="flex justify-end gap-2">
        <button
          class="px-4 py-2 text-sm rounded-lg bg-theme-700 text-theme-300 hover:bg-theme-600 transition-colors"
          @click="close"
        >
          Cancel
        </button>
        <button
          class="px-4 py-2 text-sm rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors"
          @click="save"
        >
          Save
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
