<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import type { LLMProviderConfig } from "../../api/types";
import CustomSelect, {
  type SelectOption,
  type SelectOptionGroup,
} from "./CustomSelect.vue";
import { useProviderStore } from "../../stores/provider.store";
import { useProviderLogos } from "../../composables/useProviderLogos";

interface ProviderModelSelection {
  providerId: string;
  model: string;
  label: string;
  imgSrc?: string | null;
  iconName?: string;
  tooltip?: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    providerId: string;
    modelValue: string;
    providers: Pick<
      LLMProviderConfig,
      "id" | "name" | "type" | "defaultModel"
    >[];
    modelType?: "llm" | "embedding";
    includeDefault?: boolean;
    defaultLabel?: string;
    defaultIcon?: string;
    leadingSelections?: ProviderModelSelection[];
    providerDefaultLabel?: string;
    placeholder?: string;
    maxHeight?: string;
    filterable?: boolean;
    dropUp?: boolean;
    stickyGroupHeaders?: boolean;
    align?: "left" | "center" | "right";
    dropdownWidth?: string;
    size?: "sm" | "md";
  }>(),
  {
    modelType: "llm",
    includeDefault: false,
    defaultLabel: "Use defaults",
    defaultIcon: "lucide:settings",
    leadingSelections: () => [],
    providerDefaultLabel: "Use provider default",
    placeholder: "Select provider/model…",
    maxHeight: "max-h-80",
    filterable: true,
    dropUp: false,
    align: "left",
    dropdownWidth: "w-full",
    size: "md",
  },
);

const emit = defineEmits<{
  "update:providerId": [value: string];
  "update:modelValue": [value: string];
  change: [value: { providerId: string; model: string }];
}>();

const providerStore = useProviderStore();
const { logoUrl } = useProviderLogos();

const sharedModelCache = new Map<string, string[]>();

const providerModels = ref<Record<string, string[]>>({});
const loadingByProvider = ref<Record<string, boolean>>({});
const isMobileViewport = ref(false);

function updateViewportFlags(): void {
  isMobileViewport.value = window.matchMedia("(max-width: 767px)").matches;
}

onMounted(() => {
  updateViewportFlags();
  window.addEventListener("resize", updateViewportFlags, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateViewportFlags);
});

function cacheKey(providerId: string): string {
  return `${props.modelType}:${providerId}`;
}

function encode(providerId: string, model: string): string {
  return JSON.stringify({ providerId, model });
}

function decode(value: string): { providerId: string; model: string } {
  try {
    const parsed = JSON.parse(value) as { providerId?: string; model?: string };
    return {
      providerId: parsed.providerId || "",
      model: parsed.model || "",
    };
  } catch {
    return { providerId: "", model: "" };
  }
}

async function ensureProviderModels(providerId: string): Promise<void> {
  if (!providerId) return;
  const key = cacheKey(providerId);
  if (sharedModelCache.has(key)) {
    providerModels.value = {
      ...providerModels.value,
      [providerId]: sharedModelCache.get(key) || [],
    };
    return;
  }
  if (loadingByProvider.value[providerId]) return;

  loadingByProvider.value = { ...loadingByProvider.value, [providerId]: true };
  try {
    const models = await providerStore.listModels(providerId, props.modelType);
    sharedModelCache.set(key, models);
    providerModels.value = { ...providerModels.value, [providerId]: models };
  } catch {
    providerModels.value = { ...providerModels.value, [providerId]: [] };
  } finally {
    loadingByProvider.value = {
      ...loadingByProvider.value,
      [providerId]: false,
    };
  }
}

watch(
  () => [props.providers.map((p) => p.id).join("|"), props.modelType],
  () => {
    for (const provider of props.providers) {
      void ensureProviderModels(provider.id);
    }
  },
  { immediate: true },
);

const selectedEncoded = computed(() =>
  encode(props.providerId || "", props.modelValue || ""),
);

const effectiveStickyGroupHeaders = computed(
  () => props.stickyGroupHeaders ?? !isMobileViewport.value,
);

const groups = computed((): SelectOptionGroup[] => {
  const topOptions: SelectOption[] = [];

  if (props.includeDefault) {
    topOptions.push({
      value: encode("", ""),
      label: props.defaultLabel,
      iconName: props.defaultIcon,
    });
  }

  topOptions.push(
    ...props.leadingSelections.map((s) => ({
      value: encode(s.providerId, s.model),
      label: s.label,
      imgSrc: s.imgSrc,
      iconName: s.iconName,
      tooltip: s.tooltip,
      disabled: s.disabled,
    })),
  );

  const providerGroups: SelectOptionGroup[] = props.providers.map(
    (provider) => {
      const models = providerModels.value[provider.id] || [];
      const isLoading = !!loadingByProvider.value[provider.id];
      const options: SelectOption[] = [
        {
          value: encode(provider.id, ""),
          label: `${props.providerDefaultLabel}${provider.defaultModel ? ` (${provider.defaultModel})` : ""}`,
          iconName: "lucide:settings",
          imgSrc: logoUrl(provider.type),
        },
      ];

      if (isLoading && models.length === 0) {
        options.push({
          value: encode(provider.id, "__loading__"),
          label: "Loading models…",
          iconName: "lucide:loader-2",
          disabled: true,
          imgSrc: logoUrl(provider.type),
        });
      } else if (!isLoading && models.length === 0) {
        options.push({
          value: encode(provider.id, "__none__"),
          label: "No models available",
          iconName: "lucide:circle-off",
          disabled: true,
          imgSrc: logoUrl(provider.type),
        });
      } else {
        for (const model of models) {
          options.push({
            value: encode(provider.id, model),
            label: model,
            imgSrc: logoUrl(provider.type),
          });
        }

        if (
          props.providerId === provider.id &&
          props.modelValue &&
          !models.includes(props.modelValue)
        ) {
          options.unshift({
            value: encode(provider.id, props.modelValue),
            label: props.modelValue,
            imgSrc: logoUrl(provider.type),
            tag: "Current",
          });
        }
      }

      return {
        label: provider.name,
        options,
      };
    },
  );

  return topOptions.length
    ? [{ options: topOptions }, ...providerGroups]
    : providerGroups;
});

function onSelectionChange(value: string): void {
  const selection = decode(value);
  emit("update:providerId", selection.providerId);
  emit("update:modelValue", selection.model);
  emit("change", selection);
}
</script>

<template>
  <CustomSelect
    :model-value="selectedEncoded"
    :groups="groups"
    :placeholder="placeholder"
    :max-height="maxHeight"
    :filterable="filterable"
    :drop-up="dropUp"
    :align="align"
    :dropdown-width="dropdownWidth"
    :size="size"
    :sticky-group-headers="effectiveStickyGroupHeaders"
    @update:model-value="onSelectionChange"
    @change="onSelectionChange"
  />
</template>
