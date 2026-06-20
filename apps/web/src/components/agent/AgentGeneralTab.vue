<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { useProviderStore } from "../../stores/provider.store";
import { useAgentDefinitionsStore } from "../../stores/agent-definitions.store";
import type { AgentDefinition } from "../../api/types";
import IconUpload from "../shared/IconUpload.vue";
import ProviderModelSelect from "../shared/ProviderModelSelect.vue";
import BaseCard from "../shared/BaseCard.vue";
import PromptSmartTagPicker from "../shared/PromptSmartTagPicker.vue";
import TagInput from "../shared/TagInput.vue";

const props = defineProps<{ agent: AgentDefinition }>();
const emit = defineEmits<{ update: [field: string, value: unknown] }>();

const providerStore = useProviderStore();
const agentDefs = useAgentDefinitionsStore();
const systemPromptRef = ref<HTMLTextAreaElement | null>(null);

function autoResize(e: Event) {
  const el = e.target as HTMLTextAreaElement;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

const tagSuggestions = computed(() => {
  const tagMap = new Map<string, string>();
  for (const agent of agentDefs.agents) {
    for (const tag of agent.tags || []) {
      const key = tag.toLowerCase();
      if (!tagMap.has(key)) tagMap.set(key, tag);
    }
  }
  return [...tagMap.values()].sort((a, b) => a.localeCompare(b));
});

function insertSystemPromptTag(tag: string): void {
  const el = systemPromptRef.value;
  if (!el) {
    emit("update", "systemPrompt", `${props.agent.systemPrompt}${tag}`);
    return;
  }

  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = `${el.value.slice(0, start)}${tag}${el.value.slice(end)}`;
  emit("update", "systemPrompt", next);

  nextTick(() => {
    el.focus();
    const cursor = start + tag.length;
    el.setSelectionRange(cursor, cursor);
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  });
}

onMounted(() =>
  nextTick(() => {
    if (systemPromptRef.value) {
      systemPromptRef.value.style.height = "auto";
      systemPromptRef.value.style.height =
        systemPromptRef.value.scrollHeight + "px";
    }
  }),
);
</script>

<template>
  <div class="space-y-4 mb-6">
    <!-- ── Identity ──────────────────────────────────────────── -->
    <BaseCard class="p-5 space-y-4">
      <IconUpload
        :icon-url="agent.iconUrl"
        fallback-icon="lucide:bot"
        @update="emit('update', 'iconUrl', $event)"
      >
        <template #description>
          Custom avatar for this agent. Falls back to the provider icon if not
          set.
        </template>
      </IconUpload>

      <div>
        <label class="block text-sm text-theme-400 mb-1.5">Name</label>
        <input
          :value="agent.name"
          type="text"
          class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
          @change="
            emit('update', 'name', ($event.target as HTMLInputElement).value)
          "
        >
      </div>

      <div>
        <label class="block text-sm text-theme-400 mb-1.5">Internal Name</label>
        <p class="text-xs text-theme-600 mb-2">
          Machine identifier used by the orchestrator to invoke this agent as a sub-agent (e.g. <code class="text-theme-400">web_researcher</code>). Auto-generated from the name if left empty.
        </p>
        <input
          :value="agent.internalName"
          type="text"
          placeholder="auto-generated from name"
          class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 font-mono placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500"
          @change="
            emit('update', 'internalName', ($event.target as HTMLInputElement).value)
          "
        >
      </div>

      <div>
        <label class="block text-sm text-theme-400 mb-1.5">Description</label>
        <textarea
          :value="agent.description"
          class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500 resize-none h-20"
          @change="
            emit(
              'update',
              'description',
              ($event.target as HTMLTextAreaElement).value,
            )
          "
        />
      </div>

      <div>
        <label class="block text-sm text-theme-400 mb-1.5">Tags</label>
        <TagInput
          :model-value="agent.tags"
          :suggestions="tagSuggestions"
          @update:model-value="emit('update', 'tags', $event)"
        />
      </div>

      <label class="flex items-center gap-3 rounded-lg border border-theme-800 bg-theme-900/50 px-3 py-2 text-sm text-theme-300">
        <input
          :checked="agent.favorite"
          type="checkbox"
          class="h-4 w-4 rounded border-theme-600 bg-theme-900 text-amber-400 focus:ring-amber-400/50"
          @change="emit('update', 'favorite', ($event.target as HTMLInputElement).checked)"
        >
        <span class="flex items-center gap-2">
          Favorite this agent
        </span>
      </label>
    </BaseCard>

    <!-- ── Model ─────────────────────────────────────────────── -->
    <BaseCard class="p-5 space-y-4">
      <div>
        <label class="block text-sm text-theme-400 mb-1.5">Provider / Model</label>
        <p class="text-xs text-theme-600 mb-2">
          Overrides the provider's default model for this agent. Leave empty to
          use the provider default.
        </p>
        <div class="flex gap-2">
          <div class="flex-1">
            <ProviderModelSelect
              :provider-id="agent.providerId"
              :model-value="agent.model || ''"
              :providers="providerStore.providers"
              :model-types="['llm', 'image', 'video', 'transcription']"
              placeholder="Use provider default"
              @change="
                (selection) => {
                  emit('update', 'providerId', selection.providerId);
                  emit('update', 'model', selection.model);
                }
              "
            />
          </div>
        </div>
      </div>
    </BaseCard>

    <!-- ── System Prompt ──────────────────────────────────────── -->
    <BaseCard class="p-5">
      <div class="flex items-center justify-between gap-3 mb-1.5">
        <label class="block text-sm text-theme-400">System Prompt</label>
        <PromptSmartTagPicker @insert="insertSystemPromptTag" />
      </div>
      <p class="text-xs text-theme-600 mb-2">
        Prepended as a system message alongside the built-in agentic
        instructions — does not replace them.
      </p>
      <textarea
        ref="systemPromptRef"
        :value="agent.systemPrompt"
        placeholder="Optional system instructions..."
        class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500 resize-none font-mono min-h-64"
        style="field-sizing: content"
        @change="
          emit(
            'update',
            'systemPrompt',
            ($event.target as HTMLTextAreaElement).value,
          )
        "
        @input="autoResize"
      />
    </BaseCard>
  </div>
</template>
