<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { LLMProviderConfig, ModelListItem, ModelListType, ModelPricing } from "../../api/types";
import CustomSelect, {
  type SelectOption,
  type SelectOptionGroup,
  type SelectSize,
} from "./CustomSelect.vue";
import { useProviderStore } from "../../stores/provider.store";
import { useProviderLogos } from "../../composables/useProviderLogos";
import { SK_PROVIDER_MODEL_FAVORITES } from "../../utils/storage-keys";

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
    defaultIcon?: string;
    leadingSelections?: ProviderModelSelection[];
    providerDefaultLabel?: string;
    placeholder?: string;
    maxHeight?: string;
    filterable?: boolean;
    dropUp?: boolean;
    align?: "left" | "center" | "right";
    dropdownWidth?: string;
    size?: SelectSize;
  }>(),
  {
    modelType: "llm",
    modelTypes: undefined,
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
    size: "sm",
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

function dollarsPerMillion(price?: number): number | undefined {
  return price == null ? undefined : price * 1_000_000;
}

function formatMoney(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

function firstVideoSku(pricing?: ModelPricing): { key: string; value: number } | null {
  const entries = Object.entries(pricing?.skus ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .sort(([a], [b]) => {
      const aScore = a.includes("720p") ? 0 : a.includes("duration") ? 1 : 2;
      const bScore = b.includes("720p") ? 0 : b.includes("duration") ? 1 : 2;
      return aScore - bScore || a.localeCompare(b);
    });
  if (!entries.length) return null;
  const [key, value] = entries[0];
  return { key, value };
}

function humanizeSku(key: string): string {
  return key
    .replace(/^cents_per_/, "cents ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function pricingTag(model: ModelListItem): string | undefined {
  const inputPerM = dollarsPerMillion(model.pricing?.prompt);
  const outputPerM = dollarsPerMillion(model.pricing?.completion);
  if (inputPerM !== undefined || outputPerM !== undefined) {
    return `${formatMoney(inputPerM ?? 0)}/${formatMoney(outputPerM ?? 0)}`;
  }

  const image = model.pricing?.image;
  if (image !== undefined) return `${formatMoney(image)}/img`;

  const sku = firstVideoSku(model.pricing);
  if (!sku) return undefined;
  const value = sku.key.startsWith("cents_per_") ? sku.value / 100 : sku.value;
  return `${formatMoney(value)}/sec`;
}

function pricingTooltip(model: ModelListItem): string | undefined {
  const lines: string[] = [];
  if (model.name && model.name !== model.id) lines.push(model.name);

  const inputPerM = dollarsPerMillion(model.pricing?.prompt);
  const outputPerM = dollarsPerMillion(model.pricing?.completion);
  if (inputPerM !== undefined || outputPerM !== undefined) {
    lines.push(`Tokens: ${formatMoney(inputPerM ?? 0)} input / ${formatMoney(outputPerM ?? 0)} output per 1M`);
  }
  if (model.pricing?.image !== undefined) {
    lines.push(`Image: ${formatMoney(model.pricing.image)} per image`);
  }
  if (model.pricing?.request !== undefined && model.pricing.request > 0) {
    lines.push(`Request: ${formatMoney(model.pricing.request)} per request`);
  }

  const skus = Object.entries(model.pricing?.skus ?? {}).slice(0, 4);
  for (const [key, value] of skus) {
    const amount = key.startsWith("cents_per_") ? value / 100 : value;
    lines.push(`${humanizeSku(key)}: ${formatMoney(amount)}`);
  }

  const modalities = [
    model.inputModalities?.length ? `Input: ${model.inputModalities.join(", ")}` : "",
    model.outputModalities?.length ? `Output: ${model.outputModalities.join(", ")}` : "",
  ].filter(Boolean);
  lines.push(...modalities);

  return lines.length ? lines.join("\n") : undefined;
}

function mergeModelItems(existing: ModelListItem, incoming: ModelListItem): ModelListItem {
  return {
    ...existing,
    ...incoming,
    inputModalities: incoming.inputModalities?.length ? incoming.inputModalities : existing.inputModalities,
    outputModalities: incoming.outputModalities?.length ? incoming.outputModalities : existing.outputModalities,
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
        (favorite.modelType || "llm") === props.modelType,
    )
    .map((favorite) => {
      const provider = providerById.get(favorite.providerId);
      return {
        value: encode(favorite.providerId, favorite.model),
        label: favorite.model,
        imgSrc: provider ? logoUrl(provider.type) : favorite.imgSrc,
        tag: provider?.name,
        ...favoriteAction(favorite.providerId, favorite.model),
      };
    });

  const providerGroups: SelectOptionGroup[] = props.providers.map(
    (provider) => {
      const models = providerModels.value[provider.id] || [];
      const modelIds = models.map(modelId);
      const isLoading = !!loadingByProvider.value[provider.id];
      const options: SelectOption[] = [
        {
          value: encode(provider.id, ""),
          label: `${provider.name}${provider.defaultModel ? ` (${provider.defaultModel})` : ""}`,
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
            value: encode(provider.id, model.id),
            label: model.id,
            imgSrc: logoUrl(provider.type),
            tag: pricingTag(model),
            tooltip: pricingTooltip(model),
            ...favoriteAction(provider.id, model.id),
          });
        }

        if (
          props.providerId === provider.id &&
          props.modelValue &&
          !modelIds.includes(props.modelValue)
        ) {
          options.unshift({
            value: encode(provider.id, props.modelValue),
            label: props.modelValue,
            imgSrc: logoUrl(provider.type),
            tag: "Current",
            ...favoriteAction(provider.id, props.modelValue),
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
    @change="onSelectionChange"
    @option-action="toggleFavorite"
  />
</template>
