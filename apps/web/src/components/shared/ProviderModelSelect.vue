<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { LLMProviderConfig, ModelListItem, ModelListType } from "../../api/types";
import CustomSelect, {
  type SelectOption,
  type SelectOptionGroup,
  type SelectSize,
} from "./CustomSelect.vue";
import { useProviderStore } from "../../stores/provider.store";
import { api } from "../../api/client";
import { wsConnected } from "../../api/http";
import { useProviderLogos } from "../../composables/useProviderLogos";
import { SK_PROVIDER_MODEL_FAVORITES } from "../../utils/storage-keys";
import {
  compactPricingTag,
  pricingTooltipLines,
} from "../../utils/model-pricing";
import { shortModelLabel } from "../../utils/model-label";

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
    bareTrigger?: boolean;
    onlyShowAvailableModels?: boolean;
    /** Omit providers that finished loading without any models of the requested type. */
    hideEmptyProviders?: boolean;
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
    bareTrigger: false,
    onlyShowAvailableModels: false,
    hideEmptyProviders: false,
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

const sharedModelCache = new Map<string, {
  models: ModelListItem[];
  types: Record<string, ModelListType[]>;
  fetchedAt: number;
}>();
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const providerModels = ref<Record<string, ModelListItem[]>>({});
const providerModelTypes = ref<Record<string, Record<string, ModelListType[]>>>({});
const loadingByProvider = ref<Record<string, boolean>>({});
const favoriteModels = ref<ProviderModelSelection[]>(loadFavoriteModels());
const FAVORITES_CHANGED_EVENT = "cy-provider-model-favorites-changed";
let saveQueue: Promise<unknown> = Promise.resolve();
let pendingSave = false;

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

function pricingTagVariant(model: ModelListItem): SelectOption['tagVariant'] {
  const output = (model.outputModalities || []).map((item) => item.toLowerCase());
  if (output.includes('decisions')) return 'rose';
  if (output.includes('transcription')) return 'blue';
  if (output.includes('video')) return 'amber';
  if (output.includes('image')) return 'green';
  return 'default';
}

function mergeModelItems(existing: ModelListItem, incoming: ModelListItem): ModelListItem {
  return {
    ...existing,
    ...incoming,
    name: incoming.name || existing.name,
    contextLength: incoming.contextLength ?? existing.contextLength,
    inputModalities: incoming.inputModalities?.length ? incoming.inputModalities : existing.inputModalities,
    outputModalities: incoming.outputModalities?.length ? incoming.outputModalities : existing.outputModalities,
    supportsToolCalls: incoming.supportsToolCalls ?? existing.supportsToolCalls,
    pricing: incoming.pricing ?? existing.pricing,
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
  pendingSave = true;
  localStorage.setItem(
    SK_PROVIDER_MODEL_FAVORITES,
    JSON.stringify(favoriteModels.value),
  );
  window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
  const favorites = favoriteModels.value.map(({ providerId, model, modelType, label }) => ({
    providerId, model, modelType: modelType || "llm" as ModelListType, label,
  }));
  const snapshot = JSON.stringify(favoriteModels.value);
  saveQueue = saveQueue.catch(() => undefined)
    .then(() => api.modelFavorites.save(favorites))
    .then(() => {
      if (localStorage.getItem(SK_PROVIDER_MODEL_FAVORITES) === snapshot) pendingSave = false;
    });
  void saveQueue.catch(() => undefined);
}

async function restoreFavoriteModels(): Promise<void> {
  // A newly mounted selector must not read an older server value while a
  // favorite change from another selector is still being saved.
  await saveQueue.catch(() => undefined);
  if (pendingSave) {
    favoriteModels.value = loadFavoriteModels();
    persistFavoriteModels();
    await saveQueue.catch(() => undefined);
    if (pendingSave) return;
  }
  const before = localStorage.getItem(SK_PROVIDER_MODEL_FAVORITES);
  try {
    const saved = await api.modelFavorites.get();
    if (before !== localStorage.getItem(SK_PROVIDER_MODEL_FAVORITES)) return;
    if (!saved.initialized) {
      if (favoriteModels.value.length) persistFavoriteModels();
      return;
    }
    favoriteModels.value = saved.favorites;
    localStorage.setItem(SK_PROVIDER_MODEL_FAVORITES, JSON.stringify(saved.favorites));
    window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
  } catch {
    // Keep locally cached favorites while the app server is unavailable.
  }
}

function syncFavoriteModels(event?: Event): void {
  if (
    event instanceof StorageEvent &&
    event.key !== null &&
    event.key !== SK_PROVIDER_MODEL_FAVORITES
  ) {
    return;
  }
  favoriteModels.value = loadFavoriteModels();
}

onMounted(() => {
  window.addEventListener("storage", syncFavoriteModels);
  window.addEventListener(FAVORITES_CHANGED_EVENT, syncFavoriteModels);
  void restoreFavoriteModels();
});

watch(wsConnected, (connected) => {
  if (connected) void restoreFavoriteModels();
});

onBeforeUnmount(() => {
  window.removeEventListener("storage", syncFavoriteModels);
  window.removeEventListener(FAVORITES_CHANGED_EVENT, syncFavoriteModels);
});

function isFavorite(providerId: string, model: string, modelType = props.modelType): boolean {
  return favoriteModels.value.some(
    (favorite) =>
      favorite.providerId === providerId &&
      favorite.model === model &&
      (favorite.modelType || "llm") === modelType,
  );
}

function favoriteAction(
  providerId: string,
  model: string,
  modelType = props.modelType,
): Pick<
  SelectOption,
  "actionIconName" | "actionActiveIconName" | "actionActive" | "actionLabel" | "actionData"
> {
  const active = isFavorite(providerId, model, modelType);
  return {
    actionIconName: "lucide:star",
    actionActiveIconName: "lucide:star",
    actionActive: active,
    actionLabel: active ? "Remove from favorites" : "Add to favorites",
    actionData: { modelType },
  };
}

function optionModelType(providerId: string, model: string): ModelListType {
  const types = providerModelTypes.value[providerId]?.[model] || [];
  return types.includes(props.modelType) ? props.modelType : types[0] || props.modelType;
}

function toggleFavorite(option: SelectOption): void {
  const selection = decode(option.value);
  if (!selection.providerId || !selection.model) return;

  // Multiple selectors can be mounted at once. Always apply this change to the
  // latest persisted list so a stale selector cannot discard another one's
  // recently added (or removed) favorite.
  favoriteModels.value = loadFavoriteModels();
  const actionData = option.actionData as { modelType?: ModelListType } | undefined;
  const modelType = actionData?.modelType || optionModelType(selection.providerId, selection.model);
  const key = favoriteKey(selection.providerId, selection.model, modelType);
  if (isFavorite(selection.providerId, selection.model, modelType)) {
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
        modelType,
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
  const cached = sharedModelCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    providerModels.value = {
      ...providerModels.value,
      [providerId]: cached.models,
    };
    providerModelTypes.value = { ...providerModelTypes.value, [providerId]: cached.types };
    return;
  }
  if (cached) sharedModelCache.delete(key);
  if (loadingByProvider.value[providerId]) return;

  loadingByProvider.value = { ...loadingByProvider.value, [providerId]: true };
  try {
    const results = await Promise.all(
      activeModelTypes.value.map(async (type) => {
        try {
          return { type, models: await providerStore.listModelItems(providerId, type) };
        } catch {
          const models = await providerStore.listModels(providerId, type);
          return { type, models: models.map((id) => ({ id })) };
        }
      }),
    );
    const modelMap = new Map<string, ModelListItem>();
    const typeMap: Record<string, ModelListType[]> = {};
    for (const result of results) {
      for (const model of result.models) {
        const existing = modelMap.get(model.id);
        modelMap.set(model.id, existing ? mergeModelItems(existing, model) : model);
        const types = typeMap[model.id] || [];
        if (!types.includes(result.type)) typeMap[model.id] = [...types, result.type];
      }
    }
    const models = Array.from(modelMap.values()).sort((a, b) => a.id.localeCompare(b.id));
    const provider = props.providers.find((item) => item.id === providerId);
    const hasMetadata = models.some(modelHasMetadata);
    if (hasMetadata || provider?.type === 'ollama' || provider?.type === 'lmstudio' || provider?.type === 'unsloth') {
      sharedModelCache.set(key, { models, types: typeMap, fetchedAt: Date.now() });
    }
    providerModels.value = { ...providerModels.value, [providerId]: models };
    providerModelTypes.value = { ...providerModelTypes.value, [providerId]: typeMap };
  } catch {
    providerModels.value = { ...providerModels.value, [providerId]: [] };
  } finally {
    loadingByProvider.value = {
      ...loadingByProvider.value,
      [providerId]: false,
    };
  }
}

function modelHasMetadata(model: ModelListItem): boolean {
  return Boolean(
    model.name ||
    model.contextLength ||
    model.inputModalities?.length ||
    model.outputModalities?.length ||
    typeof model.supportsToolCalls === 'boolean' ||
    model.pricing
  );
}

function refreshIncompleteModels(): void {
  for (const provider of props.providers) {
    const models = providerModels.value[provider.id] || [];
    const cached = sharedModelCache.get(cacheKey(provider.id));
    if (!models.length || !models.some(modelHasMetadata) ||
        (cached && Date.now() - cached.fetchedAt >= MODEL_CACHE_TTL_MS)) {
      sharedModelCache.delete(cacheKey(provider.id));
      void ensureProviderModels(provider.id);
    }
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

const selectedTriggerLabel = computed(() => {
  // Leading selections (e.g. "Use agent model") may
  // carry sentinel values like "__agent_model__". Always show their friendly
  // label instead of the raw value, whether freshly selected or loaded from a
  // saved configuration.
  const leadingMatch = props.leadingSelections.find(
    (s) => s.providerId === (props.providerId || "") && s.model === (props.modelValue || ""),
  );
  if (leadingMatch) return leadingMatch.label;

  if (props.modelValue) return shortModelLabel(props.modelValue);

  if (!props.providerId && props.includeDefault) {
    return shortModelLabel(props.defaultLabel);
  }

  if (props.providerId && props.includeProviderDefault) {
    const provider = props.providers.find((item) => item.id === props.providerId);
    if (provider) {
      return provider.defaultModel ? shortModelLabel(provider.defaultModel) : provider.name;
    }
  }

  return undefined;
});

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
      const costTag = model ? pricingTag(model) : undefined;
      return {
        value: encode(favorite.providerId, favorite.model),
        label: favorite.model,
        imgSrc: provider ? logoUrl(provider.type) : favorite.imgSrc,
        tag: costTag,
        tagVariant: model ? pricingTagVariant(model) : "default" as const,
        tooltip: model ? pricingTooltip(model) : favorite.tooltip,
        ...favoriteAction(favorite.providerId, favorite.model, favorite.modelType || "llm"),
      };
    });

  const visibleProviders = props.hideEmptyProviders
    ? props.providers.filter((provider) =>
      loadingByProvider.value[provider.id] ||
      (providerModels.value[provider.id] || []).length > 0 ||
      provider.id === props.providerId)
    : props.providers;

  const providerGroups: SelectOptionGroup[] = visibleProviders.map(
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
        for (const model of models) {
          const modelType = optionModelType(provider.id, model.id);
          const costTag = pricingTag(model);
          options.push({
            value: encode(provider.id, model.id),
            label: model.id,
            imgSrc: logoUrl(provider.type),
            tag: costTag,
            tagVariant: pricingTagVariant(model),
            tooltip: pricingTooltip(model),
            ...favoriteAction(provider.id, model.id, modelType),
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
    :dropdown-width="dropdownWidth === 'min-w-full' ? 'min-w-full w-96 max-w-[calc(100vw-2rem)]' : dropdownWidth"
    :size="size"
    :bare-trigger="bareTrigger"
    :virtualized="true"
    :selected-label="selectedTriggerLabel"
    :sticky-group-headers="true"
    :show-selected-tag="false"
    @update:model-value="onSelectionChange"
    @option-action="toggleFavorite"
    @open="refreshIncompleteModels"
  />
</template>
