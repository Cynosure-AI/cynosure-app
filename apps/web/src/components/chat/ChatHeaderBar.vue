<script setup lang="ts">
import { computed, ref } from "vue";
import { useChatStore } from "../../stores/chat.store";
import { useProviderStore } from "../../stores/provider.store";
import { useAgentDefinitionsStore } from "../../stores/agent-definitions.store";
import { Icon } from "@iconify/vue";
import AgentSelect from "../shared/AgentSelect.vue";
import SaveAgentModal from "./inputbar/SaveAgentModal.vue";
import DebugContextModal from "./modals/DebugContextModal.vue";
import { usePreferencesStore } from "../../stores/preferences.store";

defineProps<{
  hasPlanningTasks: boolean;
  taskListOpen: boolean;
  planningTaskCount: number;
}>();

defineEmits<{ toggleTaskList: [] }>();

const chatStore = useChatStore();
const providerStore = useProviderStore();
const agentDefs = useAgentDefinitionsStore();
const prefs = usePreferencesStore();
const debugContextOpen = ref(false);

const conversationTitle = computed(
  () => chatStore.activeConversation?.title || "",
);

const agentDropdownValue = computed(() => chatStore.activeAgentId || "");

async function onAgentChange(value: string) {
  const agentId = value || null;
  await chatStore.setActiveAgent(agentId);
  if (agentId) {
    const agent = agentDefs.get(agentId);
    if (agent?.providerId) {
      providerStore.setLastUsed(agent.providerId);
    }
  }
}

const originConfig: Record<
  string,
  { icon: string; color: string; label: string }
> = {
  cron: { icon: "lucide:clock", color: "text-sky-400", label: "Cron" },
  channel: { icon: "lucide:send", color: "text-teal-400", label: "Channel" },
  "multi-agent": {
    icon: "lucide:network",
    color: "text-purple-400",
    label: "Multi-Agent",
  },
};

const activeOrigin = computed(() => {
  const origin = chatStore.activeConversation?.origin;
  return origin && origin !== "chat" ? (originConfig[origin] ?? null) : null;
});

async function newChat(): Promise<void> {
  await chatStore.startNewChat();
}

</script>

<template>
  <div
    class="shrink-0 border-b border-theme-800/60 px-3 py-2 flex items-center gap-2"
  >
    <!-- Agent selector -->
    <div class="sm:w-44 md:w-64 shrink-0">
      <AgentSelect
        :model-value="agentDropdownValue"
        :agents="agentDefs.agents"
        include-default
        default-label="Free Chat"
        default-icon="lucide:message-square"
        agents-group-label="Agents"
        placeholder="Free Chat"
        max-height="max-h-96"
        size="sm"
        @change="onAgentChange"
      />
    </div>

    <!-- Centered conversation title + origin badge (hidden on mobile) -->
    <div class="hidden sm:flex flex-1 min-w-0 items-center justify-center gap-2">
      <span
        v-if="conversationTitle"
        class="text-sm font-medium text-theme-300 truncate select-none"
      >
        {{ conversationTitle }}
      </span>
      <span
        v-if="activeOrigin"
        class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-theme-800 shrink-0"
        :class="activeOrigin.color"
      >
        <Icon
          :icon="activeOrigin.icon"
          class="w-3 h-3"
        />
        {{ activeOrigin.label }}
      </span>
    </div>

    <div class="flex-1 sm:hidden" />

    <SaveAgentModal />

    <button
      v-if="prefs.debugMode"
      type="button"
      class="shrink-0 rounded-lg p-1.5 text-amber-400 transition-colors hover:bg-amber-400/10 hover:text-amber-300"
      title="Inspect the complete LLM context"
      aria-label="Open LLM context inspector"
      @click="debugContextOpen = true"
    >
      <Icon
        icon="lucide:bug"
        class="h-4 w-4"
      />
    </button>

    <!-- Planning task list toggle -->
    <button
      type="button"
      class="relative shrink-0 rounded-lg p-1.5 transition-colors"
      :class="taskListOpen
        ? 'bg-accent-500/15 text-accent-300'
        : hasPlanningTasks ? 'text-theme-300 hover:bg-theme-800' : 'text-theme-600 hover:bg-theme-800 hover:text-theme-400'"
      :title="hasPlanningTasks ? (taskListOpen ? 'Hide tasks' : 'Show tasks') : 'No planning tasks'"
      :aria-label="hasPlanningTasks ? (taskListOpen ? 'Hide planning tasks' : 'Show planning tasks') : 'No planning tasks'"
      :aria-expanded="taskListOpen"
      :disabled="!hasPlanningTasks"
      @click="$emit('toggleTaskList')"
    >
      <Icon
        icon="lucide:list-checks"
        class="h-4 w-4"
      />
      <span
        v-if="hasPlanningTasks"
        class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-600 px-1 text-[9px] font-semibold leading-none text-white"
      >
        {{ planningTaskCount > 9 ? '9+' : planningTaskCount }}
      </span>
    </button>

    <!-- New Chat button -->
    <button
      class="flex items-center gap-1.5 px-3 py-1.5 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-xs font-medium transition-colors shrink-0"
      @click="newChat"
    >
      <Icon
        icon="lucide:plus"
        class="w-3.5 h-3.5"
      />
      <span class="hidden sm:inline">New Chat</span>
    </button>

    <DebugContextModal
      v-model="debugContextOpen"
      :conversation-id="chatStore.activeConversationId"
    />
  </div>
</template>
