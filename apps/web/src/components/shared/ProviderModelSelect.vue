<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { LLMProviderConfig, ModelListItem, ModelListType } from "../../api/types";
import CustomSelect, {
  type SelectOption,
  type SelectOptionGroup,
  type SelectSize,
} from "./CustomSelect.vue";
import { useProviderStore } from "../../stores/provider.store";
import { useProviderLogos } from "../../composables/useProviderLogos";
import { SK_PROVIDER_MODEL_FAVORITES } from "../../utils/storage-keys";
import {
  compactPricingTag,
  humanizePricingKey,
  pricingTooltipLines,
} from "../../utils/model-pricing";

interface ProviderModelSelection {
  providerId: string;
  model: string;
  modelType?: ModelListType;
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
    modelType?: ModelListType;
    modelTypes?: ModelListType[];
    includeDefault?: boolean;
    defaultLabel?: string;
    defaultTag?: string;
    defaultIcon?: string;
    leadingSelections?: ProviderModelSelection[];
    providerDefaultLabel?: string;
    includeProviderDefault?: boolean;
    placeholder?: string;
    maxHeight?: string;
    filterable?: boolean;
    dropUp?: boolean;
    align?: "left" | "center" | "right";
    dropdownWidth?: string;
    size?: SelectSize;
    onlyShowAvailableModels?: boolean;
    refreshKey?: string | number;
  }>(),
  {
    modelType: "llm",
    modelTypes: undefined,
    includeDefault: false,
    defaultLabel: "Use defaults",
    defaultTag: undefined,
    defaultIcon: "lucide:settings",
    leadingSelections: () => [],
    providerDefaultLabel: "Use provider default",
    includeProviderDefault: true,
    placeholder: "Select provider/model…",
    maxHeight: "max-h-80",
    filterable: true,
    dropUp: false,
    align: "left",
    dropdownWidth: "w-full",
    size: "sm",
    onlyShowAvailableModels: false,
    refreshKey: 0,
  },
);

const emit = defineEmits<{
  "update:providerId": [value: string];
  "update:modelValue": [value: string];
  change: [value: { providerId: string; model: string }];
}>();

const providerStore = useProviderStore();
const { logoUrl } = useProviderLogos();

const sharedModelCache = new Map<string, ModelListItem[]>();

const providerModels = ref<Record<string, ModelListItem[]>>({});
const loadingByProvider = ref<Record<string, boolean>>({});
const favoriteModels = ref<ProviderModelSelection[]>(loadFavoriteModels());

function cacheKey(providerId: string): string {
  return `${activeModelTypes.value.join("+")}:${providerId}`;
}

const activeModelTypes = computed(() =>
  props.modelTypes?.length ? props.modelTypes : [props.modelType],
);

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

function favoriteKey(
  providerId: string,
  model: string,
  modelType = props.modelType,
): string {
  return `${modelType}:${providerId}:${model}`;
}

function modelId(model: string | ModelListItem): string {
  return typeof model === "string" ? model : model.id;
}

function pricingTag(model: ModelListItem): string | undefined {
  return compactPricingTag(model);
}

function pricingTooltip(model: ModelListItem): string | undefined {
  const lines = pricingTooltipLines(model);
  return lines.length ? lines.join("\n") : undefined;
}

function outputCapabilityTag(model: ModelListItem): string | undefined {
  const output = (model.outputModalities ?? []).map((item) => item.toLowerCase());
  if (!output.length) return undefined;
  const nonTextOutput = output.filter((item) => item !== "text");
  if (!nonTextOutput.length) return undefined;

  if (nonTextOutput.includes("transcription")) return "Transcription";
  if (nonTextOutput.includes("video")) return output.includes("text") ? "Video + text" : "Video";
  if (nonTextOutput.includes("image")) return output.includes("text") ? "Image + text" : "Image";
  if (nonTextOutput.includes("audio")) return output.includes("text") ? "Audio + text" : "Audio";
  return nonTextOutput.map((item) => humanizePricingKey(item)).join(" + ");
}

function mergeModelItems(existing: ModelListItem, incoming: ModelListItem): ModelListItem {
  return {
    ...existing,
    ...incoming,
    inputModalities: incoming.inputModalities?.length ? incoming.inputModalities : existing.inputModalities,
    outputModalities: incoming.outputModalities?.length ? incoming.outputModalities : existing.outputModalities,
    supportsToolCalls: incoming.supportsToolCalls ?? existing.supportsToolCalls,
    pricing: {
      ...existing.pricing,
      ...incoming.pricing,
      skus: {
        ...existing.pricing?.skus,
        ...incoming.pricing?.skus,
      },
    },
  };
}

function loadFavoriteModels(): ProviderModelSelection[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SK_PROVIDER_MODEL_FAVORITES) || "[]",
    ) as ProviderModelSelection[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((favorite) => favorite.providerId && favorite.model);
  } catch {
    return [];
  }
}

function persistFavoriteModels(): void {
  localStorage.setItem(
    SK_PROVIDER_MODEL_FAVORITES,
    JSON.stringify(favoriteModels.value),
  );
}

function isFavorite(providerId: string, model: string): boolean {
  return favoriteModels.value.some(
    (favorite) =>
      favorite.providerId === providerId &&
      favorite.model === model &&
      (favorite.modelType || "llm") === props.modelType,
  );
}

function favoriteAction(
  providerId: string,
  model: string,
): Pick<
  SelectOption,
  "actionIconName" | "actionActiveIconName" | "actionActive" | "actionLabel"
> {
  const active = isFavorite(providerId, model);
  return {
    actionIconName: "lucide:star",
    actionActiveIconName: "lucide:star",
    actionActive: active,
    actionLabel: active ? "Remove from favorites" : "Add to favorites",
  };
}

function toggleFavorite(option: SelectOption): void {
  const selection = decode(option.value);
  if (!selection.providerId || !selection.model) return;

  const key = favoriteKey(selection.providerId, selection.model);
  if (isFavorite(selection.providerId, selection.model)) {
    favoriteModels.value = favoriteModels.value.filter(
      (favorite) =>
        favoriteKey(favorite.providerId, favorite.model, favorite.modelType) !==
        key,
    );
  } else {
    const provider = props.providers.find((p) => p.id === selection.providerId);
    favoriteModels.value = [
      ...favoriteModels.value,
      {
        providerId: selection.providerId,
        model: selection.model,
        modelType: props.modelType,
        label: selection.model,
        imgSrc: provider ? logoUrl(provider.type) : null,
      },
    ];
  }

  persistFavoriteModels();
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
    const results = await Promise.all(
      activeModelTypes.value.map(async (type) => {
        try {
          return await providerStore.listModelItems(providerId, type);
        } catch {
          const models = await providerStore.listModels(providerId, type);
          return models.map((id) => ({ id }));
        }
      }),
    );
    const modelMap = new Map<string, ModelListItem>();
    for (const model of results.flat()) {
      const existing = modelMap.get(model.id);
      modelMap.set(model.id, existing ? mergeModelItems(existing, model) : model);
    }
    const models = Array.from(modelMap.values()).sort((a, b) => a.id.localeCompare(b.id));
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
  () => [props.providers.map((p) => p.id).join("|"), activeModelTypes.value.join("+")],
  () => {
    for (const provider of props.providers) {
      void ensureProviderModels(provider.id);
    }
  },
  { immediate: true },
);

watch(
  () => props.refreshKey,
  () => {
    const nextModels = { ...providerModels.value };
    for (const provider of props.providers) {
      sharedModelCache.delete(cacheKey(provider.id));
      delete nextModels[provider.id];
    }
    providerModels.value = nextModels;
    for (const provider of props.providers) {
      void ensureProviderModels(provider.id);
    }
  },
);

const selectedEncoded = computed(() =>
  encode(props.providerId || "", props.modelValue || ""),
);

const groups = computed((): SelectOptionGroup[] => {
  const topOptions: SelectOption[] = [];
  const providerById = new Map(
    props.providers.map((provider) => [provider.id, provider]),
  );

  if (props.includeDefault) {
    topOptions.push({
      value: encode("", ""),
      label: props.defaultLabel,
      iconName: props.defaultIcon,
      tag: props.defaultTag,
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

  const favorites: SelectOption[] = favoriteModels.value
    .filter(
      (favorite) =>
        providerById.has(favorite.providerId) &&
        activeModelTypes.value.includes(favorite.modelType || "llm") &&
        (!props.onlyShowAvailableModels ||
          (providerModels.value[favorite.providerId] || []).some((model) => model.id === favorite.model)),
    )
    .map((favorite) => {
      const provider = providerById.get(favorite.providerId);
      const model = (providerModels.value[favorite.providerId] || []).find(
        (item) => item.id === favorite.model,
      );
      const capabilityTag = model ? outputCapabilityTag(model) : undefined;
      const costTag = model ? pricingTag(model) : undefined;
      return {
        value: encode(favorite.providerId, favorite.model),
        label: favorite.model,
        imgSrc: provider ? logoUrl(provider.type) : favorite.imgSrc,
        tag: capabilityTag || costTag,
        tagVariant: capabilityTag ? "cyan" as const : "default" as const,
        tooltip: model ? pricingTooltip(model) : favorite.tooltip,
        ...favoriteAction(favorite.providerId, favorite.model),
      };
    });

  const providerGroups: SelectOptionGroup[] = props.providers.map(
    (provider) => {
      const models = providerModels.value[provider.id] || [];
      const modelIds = models.map(modelId);
      const isLoading = !!loadingByProvider.value[provider.id];
      const options: SelectOption[] = [];

      if (props.includeProviderDefault) {
        options.push({
          value: encode(provider.id, ""),
          label: `${provider.name}${provider.defaultModel ? ` (${provider.defaultModel})` : ""}`,
          iconName: "lucide:settings",
          imgSrc: logoUrl(provider.type),
        });
      }

      if (
        props.providerId === provider.id &&
        props.modelValue &&
        !props.onlyShowAvailableModels &&
        !modelIds.includes(props.modelValue)
      ) {
        options.push({
          value: encode(provider.id, props.modelValue),
          label: props.modelValue,
          imgSrc: logoUrl(provider.type),
          tag: "Current",
          ...favoriteAction(provider.id, props.modelValue),
        });
      }

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
        const preferCostTag = activeModelTypes.value.some(
          (type) => type === "embedding" || type === "reranker",
        );
        for (const model of models) {
          const capabilityTag = outputCapabilityTag(model);
          const costTag = pricingTag(model);
          const tag = preferCostTag
            ? costTag || capabilityTag
            : capabilityTag || costTag;
          options.push({
            value: encode(provider.id, model.id),
            label: model.id,
            imgSrc: logoUrl(provider.type),
            tag,
            tagVariant: tag === capabilityTag ? 'cyan' : 'default',
            tooltip: pricingTooltip(model),
            ...favoriteAction(provider.id, model.id),
          });
        }
      }

      return {
        label: provider.name,
        options,
      };
    },
  );

  return [
    ...(favorites.length ? [{ label: "Favorites", options: favorites }] : []),
    ...(topOptions.length ? [{ options: topOptions }] : []),
    ...providerGroups,
  ];
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
    :sticky-group-headers="true"
    @update:model-value="onSelectionChange"
    @option-action="toggleFavorite"
  />
</template>
