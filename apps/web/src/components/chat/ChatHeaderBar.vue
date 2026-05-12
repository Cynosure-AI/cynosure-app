<script setup lang="ts">
import { computed, ref, nextTick } from "vue";
import { useChatStore } from "../../stores/chat.store";
import { useAgentStore } from "../../stores/agent-runtime.store";
import { useProviderStore } from "../../stores/provider.store";
import { useAgentDefinitionsStore } from "../../stores/agent-definitions.store";
import { Icon } from "@iconify/vue";
import AgentSelect from "../shared/AgentSelect.vue";
import { useChatSidebar } from "../../composables/useSidebar";

const chatStore = useChatStore();
const agentStore = useAgentStore();
const providerStore = useProviderStore();
const agentDefs = useAgentDefinitionsStore();
const { chatSidebarOpen, toggle: toggleSidebar } = useChatSidebar();

const selectedAgent = computed(() =>
  chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null,
);

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
  chatStore.startNewChat();
  agentStore.clearExecution();
}

// ── Inline title editing ──
const isEditingTitle = ref(false);
const editingTitleValue = ref("");
const titleInputRef = ref<HTMLInputElement | null>(null);

function startEditTitle(): void {
  if (!chatStore.activeConversation) return;
  editingTitleValue.value = chatStore.activeConversation.title;
  isEditingTitle.value = true;
  nextTick(() => {
    titleInputRef.value?.select();
  });
}

async function commitTitleEdit(): Promise<void> {
  if (!isEditingTitle.value) return;
  isEditingTitle.value = false;
  const id = chatStore.activeConversationId;
  if (id && editingTitleValue.value.trim()) {
    await chatStore.renameConversation(id, editingTitleValue.value);
  }
}

function cancelTitleEdit(): void {
  isEditingTitle.value = false;
}

function onTitleKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter") commitTitleEdit();
  else if (e.key === "Escape") cancelTitleEdit();
}
</script>

<template>
  <div
    class="shrink-0 border-b border-theme-800/60 px-3 py-2 flex items-center gap-2"
  >
    <!-- Sidebar toggle -->
    <button
      class="p-1.5 rounded-lg hover:bg-theme-800 transition-colors text-theme-500 hover:text-theme-300 shrink-0"
      title="Toggle chat history"
      @click="toggleSidebar"
    >
      <Icon
        :icon="
          chatSidebarOpen ? 'lucide:panel-left-close' : 'lucide:panel-left-open'
        "
        class="w-4 h-4"
      />
    </button>

    <!-- Agent selector -->
    <div class="w-32 sm:w-44 shrink-0">
      <AgentSelect
        :model-value="agentDropdownValue"
        :agents="agentDefs.agents"
        include-default
        default-label="Default"
        default-icon="lucide:message-square"
        agents-group-label="Agents"
        placeholder="Default"
        max-height="max-h-96"
        size="sm"
        @change="onAgentChange"
      />
    </div>

    <!-- Centered conversation title + origin badge -->
    <div class="flex-1 min-w-0 flex items-center justify-center gap-2">
      <input
        v-if="isEditingTitle"
        ref="titleInputRef"
        v-model="editingTitleValue"
        class="text-sm font-medium text-theme-300 bg-theme-800 border border-theme-600 rounded px-2 py-0.5 max-w-xs w-full focus:outline-none focus:border-accent-500"
        @blur="commitTitleEdit"
        @keydown="onTitleKeydown"
      >
      <span
        v-else-if="conversationTitle"
        class="text-sm font-medium text-theme-300 truncate select-none cursor-pointer"
        title="Double-click to rename"
        @dblclick="startEditTitle"
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
  </div>
</template>
