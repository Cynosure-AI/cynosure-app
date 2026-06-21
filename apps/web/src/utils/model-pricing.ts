import type { ModelListItem, ModelPricing } from "../api/types";

type PricingModel = Pick<ModelListItem, "id" | "name" | "inputModalities" | "outputModalities"> & {
  pricing?: ModelPricing | null;
};

export interface PricingRow {
  label: string;
  value: string;
}

export interface PricingSummary {
  tokenRows: PricingRow[];
  mediaRows: PricingRow[];
  extraRows: PricingRow[];
  skuRows: PricingRow[];
}

export function formatMoney(value: number): string {
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  if (abs < 0.000001) return `$${value.toExponential(2)}`;
  if (abs < 0.01) return `$${value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (abs < 1) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(2)}`;
}

export function humanizePricingKey(key: string): string {
  return key
    .replace(/^cents_per_/, "cents ")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function modalities(model: PricingModel | null | undefined, direction: "input" | "output"): string[] {
  const values = direction === "input" ? model?.inputModalities : model?.outputModalities;
  return (values ?? []).map((item) => item.toLowerCase());
}

function modelIdentity(model: PricingModel): string {
  return `${model.id} ${model.name ?? ""}`.toLowerCase();
}

function isTranscriptionModel(model: PricingModel): boolean {
  return modalities(model, "output").includes("transcription");
}

function isMediaOnlyOutput(model: PricingModel): boolean {
  const output = modalities(model, "output");
  return output.length > 0 && !output.includes("text");
}

function transcriptionDurationUnit(model: PricingModel): "hour" | "minute" | null {
  const id = modelIdentity(model);
  if (id.includes("mai-transcribe")) return "hour";
  if (/(?:^|[/\s-])whisper|voxtral|chirp|parakeet/.test(id)) return "minute";
  return null;
}

function shouldShowTokenPair(model: PricingModel, prompt?: number, completion?: number): boolean {
  if (prompt == null && completion == null) return false;
  if ((prompt ?? 0) === 0 && (completion ?? 0) === 0 && isMediaOnlyOutput(model)) return false;
  if (isTranscriptionModel(model) && transcriptionDurationUnit(model)) return false;
  return true;
}

export function formatSkuCost(key: string, value: number): string {
  if (key.startsWith("cents_per_")) {
    return `${formatMoney(value / 100)} / ${humanizePricingKey(key.replace(/^cents_per_/, "")).toLowerCase()}`;
  }

  const normalizedKey = key.toLowerCase().replace(/-/g, "_");
  if (/(^|_)tokens?($|_)/.test(normalizedKey)) {
    return `${formatMoney(value * 1_000_000)} / 1M ${humanizePricingKey(key).toLowerCase()}`;
  }
  if (
    normalizedKey.includes("duration_seconds") ||
    normalizedKey.includes("video_second") ||
    normalizedKey.includes("per_second")
  ) {
    return `${formatMoney(value)} / sec`;
  }
  if (normalizedKey.startsWith("per_")) {
    return `${formatMoney(value)} / ${humanizePricingKey(key.replace(/^per_/, "")).toLowerCase()}`;
  }
  if (normalizedKey === "generate" || normalizedKey.includes("request")) {
    return `${formatMoney(value)} each`;
  }
  return `${formatMoney(value)} / ${humanizePricingKey(key).toLowerCase()}`;
}

export function modelPricingSummary(model: PricingModel): PricingSummary {
  const pricing = model.pricing ?? undefined;
  const tokenRows: PricingRow[] = [];
  const mediaRows: PricingRow[] = [];
  const extraRows: PricingRow[] = [];
  const skuRows: PricingRow[] = [];

  if (!pricing) return { tokenRows, mediaRows, extraRows, skuRows };

  const prompt = pricing.prompt;
  const completion = pricing.completion;
  const transcriptionUnit = isTranscriptionModel(model) ? transcriptionDurationUnit(model) : null;

  if (transcriptionUnit && prompt != null) {
    mediaRows.push({
      label: "Audio duration",
      value: `${formatMoney(prompt)} / audio ${transcriptionUnit}`,
    });
  } else if (shouldShowTokenPair(model, prompt, completion)) {
    const label = isTranscriptionModel(model) ? "Audio tokens" : "Input / Output";
    tokenRows.push({
      label,
      value: `${formatMoney((prompt ?? 0) * 1_000_000)} / ${formatMoney((completion ?? 0) * 1_000_000)} per 1M tokens`,
    });
  }

  if (pricing.image != null && pricing.image > 0) {
    mediaRows.push({ label: "Image", value: `${formatMoney(pricing.image)} / image` });
  }
  if (pricing.audio != null && pricing.audio > 0) {
    mediaRows.push({ label: "Audio unit", value: formatMoney(pricing.audio) });
  }

  if (pricing.request != null && pricing.request > 0) {
    extraRows.push({ label: "Request", value: `${formatMoney(pricing.request)} each` });
  }
  if (pricing.webSearch != null && pricing.webSearch > 0) {
    extraRows.push({ label: "Web search", value: `${formatMoney(pricing.webSearch)} each` });
  }
  if (pricing.internalReasoning != null && pricing.internalReasoning > 0) {
    extraRows.push({ label: "Reasoning", value: `${formatMoney(pricing.internalReasoning * 1_000_000)} / 1M tokens` });
  }
  if (pricing.inputCacheRead != null && pricing.inputCacheRead > 0) {
    extraRows.push({ label: "Cache read", value: `${formatMoney(pricing.inputCacheRead * 1_000_000)} / 1M tokens` });
  }
  if (pricing.inputCacheWrite != null && pricing.inputCacheWrite > 0) {
    extraRows.push({ label: "Cache write", value: `${formatMoney(pricing.inputCacheWrite * 1_000_000)} / 1M tokens` });
  }

  for (const [key, value] of Object.entries(pricing.skus ?? {}).filter(([, value]) => Number.isFinite(value)).slice(0, 6)) {
    skuRows.push({ label: humanizePricingKey(key), value: formatSkuCost(key, value) });
  }

  return { tokenRows, mediaRows, extraRows, skuRows };
}

export function compactPricingTag(model: PricingModel): string | undefined {
  const summary = modelPricingSummary(model);
  const first = summary.tokenRows[0] ?? summary.mediaRows[0] ?? summary.skuRows[0] ?? summary.extraRows[0];
  if (!first) return undefined;
  return first.value
    .replace(" per 1M tokens", "/M")
    .replace(" / 1M ", "/M ")
    .replace(" / audio minute", "/min")
    .replace(" / audio hour", "/hr")
    .replace(" / image", "/img")
    .replace(" each", "");
}

export function pricingTooltipLines(model: PricingModel): string[] {
  const lines: string[] = [];
  if (model.name && model.name !== model.id) lines.push(model.name);

  const summary = modelPricingSummary(model);
  for (const row of [...summary.tokenRows, ...summary.mediaRows, ...summary.extraRows, ...summary.skuRows]) {
    lines.push(`${row.label}: ${row.value}`);
  }

  const input = model.inputModalities?.length ? `Input: ${model.inputModalities.join(", ")}` : "";
  const output = model.outputModalities?.length ? `Output: ${model.outputModalities.join(", ")}` : "";
  if (input) lines.push(input);
  if (output) lines.push(output);

  return lines;
}
