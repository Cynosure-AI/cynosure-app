<script setup lang="ts">
import McpRegisteredToolsPanel from './McpRegisteredToolsPanel.vue'
import BaseCard from '../../shared/BaseCard.vue'
</script>

<template>
  <div>
    <p class="text-xs text-zinc-500 mb-4">
      Set the default HITL behaviour for each registered MCP tool. <strong class="text-zinc-400">Auto-confirm</strong> lets the agent call the tool without asking you first; <strong class="text-zinc-400">Ask</strong> pauses for your approval.
    </p>
    <BaseCard class="overflow-hidden">
      <McpRegisteredToolsPanel />
    </BaseCard>
  </div>
</template>
