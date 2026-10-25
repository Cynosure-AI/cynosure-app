import { computed, ref, type WritableComputedRef } from 'vue'
import { SK_VIEW_LAYOUT } from '../utils/storage-keys'

export type ViewLayout = 'list' | 'grid'

function readStored(): ViewLayout | null {
    try {
        const value = sessionStorage.getItem(SK_VIEW_LAYOUT)
        return value === 'list' || value === 'grid' ? value : null
    } catch {
        return null
    }
}

/** The list/grid choice, shared by every view with a layout toggle and kept for the browser session. */
const chosen = ref<ViewLayout | null>(readStored())

/** `fallback` applies until the user picks a layout anywhere. */
export function useViewLayout(fallback: ViewLayout | (() => ViewLayout)): WritableComputedRef<ViewLayout> {
    return computed({
        get: () => chosen.value ?? (typeof fallback === 'function' ? fallback() : fallback),
        set: (layout) => {
            chosen.value = layout
            try {
                sessionStorage.setItem(SK_VIEW_LAYOUT, layout)
            } catch {
                // Storage can be unavailable; the choice still holds until reload.
            }
        },
    })
}

/** Test hook: forget the shared choice. */
export function resetViewLayout(): void {
    chosen.value = null
}
