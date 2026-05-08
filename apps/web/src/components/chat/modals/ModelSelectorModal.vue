<script setup lang="ts">
import { computed } from "vue";
import { useChatStore } from "../../../stores/chat.store";
import { useAgentDefinitionsStore } from "../../../stores/agent-definitions.store";
import { useProviderStore } from "../../../stores/provider.store";
import ModalDialog from "../../shared/ModalDialog.vue";
import ProviderModelSelect from "../../shared/ProviderModelSelect.vue";

const chatStore = useChatStore();
const agentDefs = useAgentDefinitionsStore();
const providerStore = useProviderStore();

const visible = defineModel<boolean>({ required: true });

const selectedAgent = computed(() =>
  chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null,
);

const currentProviderId = computed(
  () =>
    chatStore.sessionProviderOverride ||
    selectedAgent.value?.providerId ||
    providerStore.lastUsedProviderId,
);

const currentProvider = computed(() =>
  providerStore.providers.find((p) => p.id === currentProviderId.value),
);

const defaultModelLabel = computed(() => {
  const agentModel = selectedAgent.value?.model;
  const providerDefault = currentProvider.value?.defaultModel;
  const isProviderOverridden =
    chatStore.sessionProviderOverride &&
    chatStore.sessionProviderOverride !== selectedAgent.value?.providerId;
  const effectiveDefault = isProviderOverridden
    ? providerDefault
    : agentModel || providerDefault;
  return effectiveDefault || "Provider default";
});

const selectedModel = computed(() => chatStore.sessionModelOverride || "");

function onSelectionChange(selection: {
  providerId: string;
  model: string;
}): void {
  chatStore.sessionModelOverride = selection.model || null;

  if (chatStore.activeAgentId) {
    chatStore.sessionProviderOverride =
      selection.providerId !== selectedAgent.value?.providerId
        ? selection.providerId
        : null;
  } else {
    chatStore.sessionProviderOverride = selection.providerId;
    if (selection.providerId) {
      providerStore.setLastUsed(selection.providerId);
    }
  }

  chatStore.markOverridesModified();
  visible.value = false;
}
</script>

<template>
  <ModalDialog
    :show="visible"
    title="Select Provider / Model"
    icon="lucide:cpu"
    icon-color="blue"
    max-width="max-w-lg"
    @close="visible = false"
  >
    <div class="space-y-3">
      <div
        class="rounded-lg border border-zinc-700 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-500"
      >
        Current default:
        <span class="text-zinc-300">{{ defaultModelLabel }}</span>
      </div>

      <ProviderModelSelect
        :provider-id="currentProviderId"
        :model-value="selectedModel"
        :providers="providerStore.providers"
        :include-default="!!selectedAgent"
        default-label="Use agent defaults"
        placeholder="Select provider/model"
        max-height="max-h-96"
        @change="onSelectionChange"
      />
    </div>
  </ModalDialog>
</template>
