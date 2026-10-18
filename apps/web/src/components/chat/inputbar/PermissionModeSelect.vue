<script setup lang="ts">
import type { PermissionMode } from '@shared/types'
import { useChatStore } from '../../../stores/chat.store'
import CustomSelect from '../../shared/CustomSelect.vue'

const chatStore = useChatStore()
const groups = [{
  label: 'Permissions',
  options: [
    { value: 'read-only', label: 'Read Only', iconName: 'lucide:eye', tooltip: 'Offers only read-only tools, plus project planning.' },
    { value: 'auto', label: 'Auto', iconName: 'lucide:shield-check', tooltip: 'Runs safe tools and asks before the rest.' },
    { value: 'full', label: 'Full Access', iconName: 'lucide:zap', tooltip: 'Runs every tool in this chat without asking.' },
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
    bare-trigger
    drop-up
    dropdown-width="w-48"
    size="xs"
    @update:model-value="setPermissionMode"
  />
</template>
