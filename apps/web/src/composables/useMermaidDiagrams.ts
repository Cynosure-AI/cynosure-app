import { watch, type Ref } from 'vue'
import { usePreferencesStore } from '../stores/preferences.store'
import { renderMermaidBlocks } from '../utils/mermaid'

/** Render mermaid code blocks inside `root` whenever its HTML or the theme changes. */
export function useMermaidDiagrams(
  root: Ref<HTMLElement | null>,
  html: () => string,
  enabled: () => boolean = () => true,
) {
  const prefs = usePreferencesStore()
  watch([root, html, enabled, () => prefs.theme], () => {
    if (root.value && enabled()) void renderMermaidBlocks(root.value)
  }, { flush: 'post', immediate: true })
}
