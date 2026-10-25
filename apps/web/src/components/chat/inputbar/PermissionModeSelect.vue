<script setup lang="ts">
import type { PermissionMode } from '@shared/types'
import { useChatStore } from '../../../stores/chat.store'
import CustomSelect from '../../shared/CustomSelect.vue'

const chatStore = useChatStore()
const modeColors: Record<PermissionMode, string> = {
  'read-only': 'text-sky-600 dark:text-sky-300',
  auto: 'text-amber-600 dark:text-amber-300',
  full: 'text-rose-600 dark:text-rose-300',
}
const groups = [{
  label: 'Permissions',
  options: [
    { value: 'read-only', label: 'Read Only', iconName: 'lucide:eye', iconClass: modeColors['read-only'], tooltip: 'Offers read-only tools and project planning.' },
    { value: 'auto', label: 'Auto', iconName: 'lucide:shield-check', iconClass: modeColors.auto, tooltip: 'Runs safe tools and asks before the rest.' },
    { value: 'full', label: 'Full Access', iconName: 'lucide:zap', iconClass: modeColors.full, tooltip: 'Runs every tool in this chat without asking.' },
  ],
}]

function setPermissionMode(value: string): void {
  chatStore.setPermissionMode(value as PermissionMode).catch((err: unknown) => {
    console.error('[chat] Failed to change tool permissions:', err)
  })
}
</script>

<template>
  <CustomSelect
    class="!w-auto shrink-0"
    title="Tool permissions"
    :model-value="chatStore.permissionMode"
    :groups="groups"
    :chevron-class="modeColors[chatStore.permissionMode]"
    bare-trigger
    mobile-icon-only
    drop-up
    dropdown-width="w-48"
    size="xs"
    @update:model-value="setPermissionMode"
  />
</template>
