<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import type { ToolBehaviorAnnotations } from '../../stores/agent-runtime.store'

interface BehaviorBadge {
  key: string
  label: string
  icon: string
  classes: string
  title: string
}

const props = defineProps<{
  annotations?: ToolBehaviorAnnotations
}>()

const badges = computed<BehaviorBadge[]>(() => {
  const annotations = props.annotations
  if (!annotations) return []

  const result: BehaviorBadge[] = []

  if (annotations.readOnlyHint !== undefined) {
    result.push(annotations.readOnlyHint
      ? {
          key: 'read-only',
          label: 'read only',
          icon: 'lucide:eye',
          classes: 'bg-green-500/10 text-status-green',
          title: 'Server-declared hint: this tool does not modify its environment.',
        }
      : {
          key: 'writes',
          label: 'writes',
          icon: 'lucide:pencil',
          classes: 'bg-amber-500/10 text-status-warning',
          title: 'Server-declared hint: this tool may modify its environment.',
        })
  }

  // Destructive and idempotent only describe tools that may write.
  if (annotations.readOnlyHint !== true && annotations.destructiveHint !== undefined) {
    result.push(annotations.destructiveHint
      ? {
          key: 'destructive',
          label: 'destructive',
          icon: 'lucide:triangle-alert',
          classes: 'bg-red-500/10 text-status-danger',
          title: 'Server-declared hint: this tool may delete or overwrite existing state.',
        }
      : {
          key: 'additive',
          label: 'additive',
          icon: 'lucide:plus',
          classes: 'bg-blue-500/10 text-blue-400',
          title: 'Server-declared hint: this tool performs only additive updates.',
        })
  }

  if (annotations.readOnlyHint !== true && annotations.idempotentHint !== undefined) {
    result.push(annotations.idempotentHint
      ? {
          key: 'idempotent',
          label: 'idempotent',
          icon: 'lucide:repeat-2',
          classes: 'bg-cyan-500/10 text-cyan-400',
          title: 'Server-declared hint: repeating the same call has no additional effect.',
        }
      : {
          key: 'repeat-effects',
          label: 'repeat effects',
          icon: 'lucide:repeat',
          classes: 'bg-orange-500/10 text-orange-400',
          title: 'Server-declared hint: repeating the same call may cause additional effects.',
        })
  }

  if (annotations.openWorldHint !== undefined) {
    result.push(annotations.openWorldHint
      ? {
          key: 'open-world',
          label: 'external',
          icon: 'lucide:globe-2',
          classes: 'bg-violet-500/10 text-status-violet',
          title: 'Server-declared hint: this tool may interact with external systems or data.',
        }
      : {
          key: 'closed-world',
          label: 'local scope',
          icon: 'lucide:box',
          classes: 'bg-theme-800 text-theme-400',
          title: 'Server-declared hint: this tool operates within a closed domain.',
        })
  }

  return result
})
</script>

<template>
  <div
    v-if="badges.length"
    class="flex flex-wrap items-center gap-1"
    aria-label="Server-declared tool behavior hints"
  >
    <span
      v-for="badge in badges"
      :key="badge.key"
      class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide"
      :class="badge.classes"
      :title="badge.title"
    >
      <Icon
        :icon="badge.icon"
        class="h-2.5 w-2.5"
      />
      {{ badge.label }}
    </span>
  </div>
</template>
