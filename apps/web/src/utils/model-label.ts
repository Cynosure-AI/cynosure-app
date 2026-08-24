export function shortModelLabel(modelId: string): string {
  return modelId.split('/').filter(Boolean).at(-1) || modelId
}
