<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { PermissionMode } from '@shared/types'

defineProps<{ modelValue: PermissionMode }>()
const emit = defineEmits<{ 'update:modelValue': [value: PermissionMode] }>()

const modes: Array<{ value: PermissionMode; label: string; description: string; icon: string }> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Runs safe tools and asks before the rest.',
    icon: 'lucide:shield-check',
  },
  {
    value: 'full',
    label: 'Full Access',
    description: 'Runs every tool in this chat without asking.',
    icon: 'lucide:zap',
  },
]
</script>

<template>
  <div
    role="radiogroup"
    aria-label="Tool permissions"
  >
    <div class="text-xs font-medium text-theme-200">
      Permissions
    </div>
    <div class="mt-2 space-y-1.5">
      <button
        v-for="mode in modes"
        :key="mode.value"
        type="button"
        role="radio"
        class="permission-option"
        :class="[
          `permission-option--${mode.value}`,
          { 'permission-option--selected': modelValue === mode.value },
        ]"
        :aria-checked="modelValue === mode.value"
        @click="emit('update:modelValue', mode.value)"
      >
        <Icon
          :icon="mode.icon"
          class="permission-option__icon"
        />
        <span class="min-w-0 flex-1">
          <span class="block text-xs font-semibold text-theme-100">{{ mode.label }}</span>
          <span class="block text-[11px] leading-snug text-ink-muted">{{ mode.description }}</span>
        </span>
        <Icon
          v-if="modelValue === mode.value"
          icon="lucide:check"
          class="permission-option__check"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
.permission-option {
  --option-color: var(--color-accent-400);

  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.625rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 45%, transparent);
  border-radius: 0.625rem;
  padding: 0.5rem 0.625rem;
  text-align: left;
  transition:
    border-color 140ms ease,
    background-color 140ms ease;
}

.permission-option--full {
  --option-color: #f59e0b;
}

.permission-option:hover {
  background: color-mix(in srgb, var(--color-theme-700) 35%, transparent);
}

.permission-option:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px var(--option-color);
}

.permission-option--selected {
  border-color: color-mix(in srgb, var(--option-color) 55%, transparent);
  background: color-mix(in srgb, var(--option-color) 8%, transparent);
}

.permission-option__icon {
  width: 1.125rem;
  height: 1.125rem;
  flex-shrink: 0;
  color: var(--color-theme-400);
}

.permission-option--selected .permission-option__icon,
.permission-option__check {
  color: var(--option-color);
}

.permission-option__check {
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
}
</style>
