<script setup lang="ts">
import McpRegisteredToolsPanel from './McpRegisteredToolsPanel.vue'
</script>

<template>
  <div>
    <p class="text-xs text-zinc-500 mb-4">
      Set the default HITL behaviour for each registered MCP tool. <strong class="text-zinc-400">Auto-confirm</strong> lets the agent call the tool without asking you first; <strong class="text-zinc-400">Ask</strong> pauses for your approval.
    </p>
    <div class="bg-zinc-800 border border-zinc-700 rounded-xl overflow-hidden">
      <McpRegisteredToolsPanel />
    </div>
  </div>
</template>
