<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useChatStore } from "../../stores/chat.store";
import { useProviderStore } from "../../stores/provider.store";
import { useAgentDefinitionsStore } from "../../stores/agent-definitions.store";
import { Icon } from "@iconify/vue";
import AgentSelect from "../shared/AgentSelect.vue";
import ChatSettingsMenu from "./ChatSettingsMenu.vue";
import { useCynoStore } from '../../stores/cyno.store'
import { agentAvatarSrc } from '../../utils/avatar'

const cyno = useCynoStore()

defineProps<{
  hasPlanningTasks: boolean;
  taskListOpen: boolean;
  planningTaskCount: number;
}>();

defineEmits<{ toggleTaskList: []; searchChat: [] }>();

const chatStore = useChatStore();
const providerStore = useProviderStore();
const agentDefs = useAgentDefinitionsStore();

const conversationTitle = computed(
  () => chatStore.activeConversation?.title || "",
);

const editingConversationId = ref<string | null>(null);
const editingTitle = ref("");
const titleInputRef = ref<HTMLInputElement | null>(null);
const titleButtonRef = ref<HTMLButtonElement | null>(null);
const savingTitle = ref(false);
const renameError = ref("");

watch(() => chatStore.activeConversationId, () => {
  editingConversationId.value = null;
  renameError.value = "";
});

async function startRename(): Promise<void> {
  const conversation = chatStore.activeConversation;
  if (!conversation || savingTitle.value) return;
  editingConversationId.value = conversation.id;
  editingTitle.value = conversation.title;
  renameError.value = "";
  await nextTick();
  titleInputRef.value?.focus();
  titleInputRef.value?.select();
}

async function cancelRename(): Promise<void> {
  editingConversationId.value = null;
  await nextTick();
  titleButtonRef.value?.focus();
}

async function commitRename(restoreFocus = false): Promise<void> {
  const id = editingConversationId.value;
  if (!id) return;
  const title = editingTitle.value.trim();
  editingConversationId.value = null;
  if (id !== chatStore.activeConversationId) return;
  if (title && title !== conversationTitle.value) {
    savingTitle.value = true;
    try {
      await chatStore.renameConversation(id, title);
    } catch {
      if (id === chatStore.activeConversationId) {
        renameError.value = "Could not rename chat. Please try again.";
      }
    } finally {
      savingTitle.value = false;
    }
  }
  if (restoreFocus && id === chatStore.activeConversationId) {
    await nextTick();
    titleButtonRef.value?.focus();
  }
}

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
  cron: { icon: "lucide:clock", color: "text-status-info", label: "Cron" },
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

// Incognito is picked on the empty new chat; once it has messages, Save keeps it.
const canToggleIncognito = computed(
  () => !chatStore.activeConversationId && chatStore.messages.length === 0,
);
const showSaveChat = computed(
  () => Boolean(chatStore.activeConversationId) && chatStore.activeIsTemporary,
);
const savingChat = ref(false);
const saveError = ref("");

watch(() => chatStore.activeConversationId, () => {
  saveError.value = "";
});

async function saveChat(): Promise<void> {
  if (savingChat.value) return;
  savingChat.value = true;
  saveError.value = "";
  try {
    await chatStore.saveActiveConversation();
  } catch {
    saveError.value = "Could not save chat. Please try again.";
  } finally {
    savingChat.value = false;
  }
}

async function newChat(): Promise<void> {
  // A new chat started from a project chat stays in that project.
  await chatStore.startNewChat({ projectId: chatStore.activeProjectId });
}

</script>

<template>
  <div
    class="chat-header-bar shrink-0 border-b border-theme-800/60 px-3 py-2 flex items-center gap-2 bg-theme-900"
  >
    <!-- Agent selector -->
    <div class="sm:w-44 md:w-64 shrink-0">
      <AgentSelect
        :model-value="agentDropdownValue"
        :agents="agentDefs.agents"
        include-default
        :default-label="cyno.name"
        :default-img-src="agentAvatarSrc(cyno.name, cyno.displayIconUrl, cyno.avatar)"
        agents-group-label="Agents"
        :placeholder="cyno.name"
        max-height="max-h-96"
        size="sm"
        @change="onAgentChange"
      />
    </div>

    <!-- Centered conversation title + origin badge (hidden on mobile) -->
    <div class="hidden sm:flex flex-1 min-w-0 items-center justify-center gap-2">
      <div
        v-if="conversationTitle"
        class="min-w-0 flex flex-col items-center gap-1"
      >
        <input
          v-if="editingConversationId"
          ref="titleInputRef"
          v-model="editingTitle"
          aria-label="Conversation title"
          class="w-64 max-w-full min-w-0 rounded border border-theme-600 bg-theme-900 px-2 py-0.5 text-center text-sm font-medium text-theme-100 outline-none focus:border-accent-500"
          @blur="commitRename()"
          @keydown.enter.prevent="commitRename(true)"
          @keydown.escape.prevent="cancelRename"
        >
        <button
          v-else
          ref="titleButtonRef"
          type="button"
          aria-label="Rename chat"
          title="Rename chat"
          :disabled="savingTitle"
          class="group flex max-w-full min-w-0 items-center gap-1.5 rounded px-2 py-0.5 text-sm font-medium text-theme-300 transition-colors hover:bg-theme-800 hover:text-theme-100 focus-visible:outline-2 focus-visible:outline-accent-500 disabled:opacity-60"
          @click="startRename"
        >
          <span class="truncate">{{ conversationTitle }}</span>
          <Icon
            icon="lucide:pencil"
            class="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        </button>
        <span
          v-if="renameError"
          role="alert"
          class="text-xs text-status-error"
        >{{ renameError }}</span>
      </div>
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
      <span
        v-if="showSaveChat"
        class="incognito-badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-theme-800 text-theme-300 shrink-0"
      >
        <Icon
          icon="lucide:hat-glasses"
          class="w-3 h-3"
        />
        Incognito
      </span>
      <span
        v-if="saveError"
        role="alert"
        class="text-xs text-status-error"
      >{{ saveError }}</span>
    </div>

    <div class="flex-1 sm:hidden" />

    <!-- Planning task list toggle -->
    <button
      v-if="hasPlanningTasks"
      type="button"
      class="planning-task-toggle relative shrink-0 rounded-lg p-1.5 transition-colors"
      :class="taskListOpen
        ? 'bg-accent-500/15 text-accent-fg'
        : 'text-theme-300 hover:bg-theme-800'"
      :title="taskListOpen ? 'Hide tasks' : 'Show tasks'"
      :aria-label="taskListOpen ? 'Hide planning tasks' : 'Show planning tasks'"
      :aria-expanded="taskListOpen"
      @click="$emit('toggleTaskList')"
    >
      <Icon
        icon="lucide:list-checks"
        class="h-4 w-4"
      />
      <span
        class="planning-task-count absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-600 px-1 text-[9px] font-semibold leading-none text-accent-on"
      >
        {{ planningTaskCount > 9 ? '9+' : planningTaskCount }}
      </span>
    </button>

    <!-- Incognito toggle (empty new chat only) -->
    <button
      v-if="canToggleIncognito"
      type="button"
      class="incognito-toggle shrink-0 rounded-lg p-1.5 transition-colors"
      :class="chatStore.activeIsTemporary
        ? 'bg-accent-500/15 text-accent-fg'
        : 'text-theme-300 hover:bg-theme-800'"
      :title="chatStore.activeIsTemporary ? 'Incognito on — this chat will not be saved' : 'Incognito chat — not saved to history'"
      aria-label="Incognito chat"
      :aria-pressed="chatStore.activeIsTemporary"
      @click="chatStore.setIncognito(!chatStore.activeIsTemporary)"
    >
      <Icon
        icon="lucide:hat-glasses"
        class="h-4 w-4"
      />
    </button>

    <!-- Save an incognito chat to the history -->
    <button
      v-if="showSaveChat"
      type="button"
      class="save-chat shrink-0 rounded-lg p-1.5 text-theme-300 transition-colors hover:bg-theme-800 hover:text-theme-100 disabled:opacity-60"
      title="Save chat to history"
      aria-label="Save chat to history"
      :disabled="savingChat"
      @click="saveChat"
    >
      <Icon
        icon="lucide:bookmark-plus"
        class="h-4 w-4"
      />
    </button>

    <!-- New Chat button -->
    <button
      class="flex items-center gap-1.5 px-3 py-1.5 accent-action bg-accent-600 hover:bg-accent-500 text-accent-on rounded-lg text-xs font-medium transition-colors shrink-0"
      @click="newChat"
    >
      <Icon
        icon="lucide:plus"
        class="w-3.5 h-3.5"
      />
      <span class="hidden sm:inline">New Chat</span>
    </button>

    <ChatSettingsMenu @search="$emit('searchChat')" />
  </div>
</template>
