<script setup lang="ts">
import McpSettings from '../../components/settings/McpSettings.vue'
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-100">
          MCP Servers
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Connect MCP (Model Context Protocol) servers to add external tools the LLM can use
        </p>
      </div>
      <McpSettings />
    </div>
  </div>
</template>
