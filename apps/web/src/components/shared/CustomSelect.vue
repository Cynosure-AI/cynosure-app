<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
} from "vue";
import { Icon } from "@iconify/vue";

export interface SelectOption {
  value: string;
  label: string;
  imgSrc?: string | null;
  iconName?: string;
  tooltip?: string;
  disabled?: boolean;
  /** Small badge shown to the right of the label (e.g. "+3") */
  tag?: string;
  /** Visual variant for the tag badge. */
  tagVariant?: 'default' | 'cyan' | 'green' | 'blue';
  /** Iconify icon name shown as a small badge instead of text */
  tagIconName?: string;
  actionIconName?: string;
  actionActiveIconName?: string;
  actionActive?: boolean;
  actionLabel?: string;
  /** Opaque metadata returned with option-action events. */
  actionData?: unknown;
}

export interface SelectOptionGroup {
  /** Shown as a group header; omit for ungrouped options */
  label?: string;
  options: SelectOption[];
}

export type SelectSize = "xs" | "sm" | "md" | "lg";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    groups: SelectOptionGroup[];
    placeholder?: string;
    placeholderIcon?: string;
    /** Max height CSS class for the dropdown list (default: 'max-h-56') */
    maxHeight?: string;
    /** Show a text input inside the dropdown for filtering options */
    filterable?: boolean;
    /** Width class(es) for the dropdown panel (default: 'w-full'). Use e.g. 'min-w-full' to auto-expand to contents. */
    dropdownWidth?: string;
    /** When true the dropdown opens above the trigger instead of below */
    dropUp?: boolean;
    /** Keep option group labels visible while scrolling the option list */
    stickyGroupHeaders?: boolean;
    /** Text alignment for the trigger label: 'left' | 'center' | 'right' */
    align?: "left" | "center" | "right";
    /** Show the selected option's tag in the closed trigger */
    showSelectedTag?: boolean;
    /**
     * Trigger button size:
     * - 'xs' — extra compact (text-xs, py-1, px-2)
     * - 'sm' — compact (text-sm, py-1.5, px-2.5)
     * - 'md' — standard form size (text-base, py-2, px-3)
     * - 'lg' — large form size (text-lg, py-2.5, px-3.5)
     */
    size?: SelectSize;
  }>(),
  {
    placeholder: "Select...",
    placeholderIcon: "lucide:chevrons-up-down",
    maxHeight: "max-h-56",
    dropdownWidth: "w-full",
    dropUp: false,
    stickyGroupHeaders: false,
    align: "left",
    showSelectedTag: true,
    size: "sm",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
  "option-action": [option: SelectOption];
  open: [];
}>();

const isOpen = ref(false);
const containerRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const filterInputRef = ref<HTMLInputElement | null>(null);
/** Which option is keyboard-focused (by value) */
const focusedValue = ref<string>("");
/** True when the last focus change came from keyboard navigation (not mouse hover) */
const keyboardNav = ref(false);
const filterQuery = ref("");

const allOptions = computed(() => props.groups.flatMap((g) => g.options));
const selectedOption = computed(
  () => allOptions.value.find((o) => o.value === props.modelValue) ?? null,
);

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Match every query term against user-visible option text. */
function searchMatches(text: string, query: string): boolean {
  const haystack = normalizeSearchText(text);
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}

const filteredGroups = computed(() => {
  if (!props.filterable || !filterQuery.value.trim()) return props.groups;
  const q = filterQuery.value;
  return props.groups
    .map((g) => ({
      ...g,
      options: g.options.filter((o) =>
        searchMatches(`${g.label || ""} ${o.label} ${o.tooltip || ""}`, q)
      ),
    }))
    .filter((g) => g.options.length > 0);
});

const filteredAllOptions = computed(() =>
  filteredGroups.value.flatMap((g) => g.options),
);

/** True when at least one visible option carries an icon — avoids wasting column space */
const hasOptionIcons = computed(() =>
  filteredAllOptions.value.some((o) => o.imgSrc || o.iconName),
);

const sizeClasses: Record<
  SelectSize,
  {
    trigger: string;
    filterInput: string;
    empty: string;
    option: string;
  }
> = {
  xs: {
    trigger: "text-xs px-2 py-1",
    filterInput: "text-xs px-2 py-1",
    empty: "text-xs",
    option: "text-xs px-2 py-1",
  },
  sm: {
    trigger: "text-sm px-2.5 py-1.5",
    filterInput: "text-sm px-2.5 py-1",
    empty: "text-sm",
    option: "text-sm px-2.5 py-1.5",
  },
  md: {
    trigger: "text-base px-3 py-2",
    filterInput: "text-base px-3 py-1.5",
    empty: "text-base",
    option: "text-base px-3 py-2",
  },
  lg: {
    trigger: "text-lg px-3.5 py-2.5",
    filterInput: "text-lg px-3.5 py-2",
    empty: "text-lg",
    option: "text-lg px-3.5 py-2.5",
  },
};

const currentSizeClasses = computed(() => sizeClasses[props.size]);

function tagVariantClasses(variant: SelectOption['tagVariant']): string {
  if (variant === 'cyan') return 'bg-cyan-500/10 text-cyan-400'
  if (variant === 'green') return 'bg-emerald-500/10 text-emerald-400'
  if (variant === 'blue') return 'bg-blue-500/10 text-blue-400'
  return 'bg-violet-500/10 text-violet-400'
}

function open(): void {
  filterQuery.value = "";
  isOpen.value = true;
  emit("open");
  focusedValue.value = props.modelValue;
  if (props.filterable) {
    nextTick(() => filterInputRef.value?.focus());
  }
}

function toggle(): void {
  if (isOpen.value) {
    isOpen.value = false;
  } else {
    open();
  }
}

function selectOption(value: string): void {
  if (allOptions.value.find((o) => o.value === value)?.disabled) return;
  emit("update:modelValue", value);
  emit("change", value);
  isOpen.value = false;
}

function triggerOptionAction(option: SelectOption): void {
  if (option.disabled) return;
  emit("option-action", option);
}

function handleKeydown(e: KeyboardEvent): void {
  const opts = props.filterable ? filteredAllOptions.value : allOptions.value;
  if (!isOpen.value) {
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      open();
    }
    return;
  }
  const idx = opts.findIndex((o) => o.value === focusedValue.value);
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      keyboardNav.value = true;
      focusedValue.value =
        nextEnabledOption(opts, idx, 1)?.value || focusedValue.value;
      break;
    case "ArrowUp":
      e.preventDefault();
      keyboardNav.value = true;
      focusedValue.value =
        nextEnabledOption(opts, idx, -1)?.value || focusedValue.value;
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      if (idx >= 0) selectOption(opts[idx].value);
      break;
    case "Escape":
      e.preventDefault();
      isOpen.value = false;
      break;
    case "Tab":
      isOpen.value = false;
      break;
  }
}

function nextEnabledOption(
  opts: SelectOption[],
  startIdx: number,
  direction: 1 | -1,
): SelectOption | null {
  if (!opts.length) return null;
  for (let i = 1; i <= opts.length; i++) {
    const idx = (startIdx + i * direction + opts.length) % opts.length;
    if (!opts[idx].disabled) return opts[idx];
  }
  return null;
}

function handleClickOutside(e: MouseEvent): void {
  if (containerRef.value && !containerRef.value.contains(e.target as Node)) {
    isOpen.value = false;
  }
}

/** When filter changes, move focus to first visible option if current one is hidden */
watch(filterQuery, () => {
  const opts = filteredAllOptions.value;
  if (opts.length && !opts.find((o) => o.value === focusedValue.value)) {
    focusedValue.value = opts[0].value;
  }
});

/** Scroll keyboard-focused item into view (only for keyboard nav, not mouse hover) */
watch(focusedValue, (val) => {
  if (!keyboardNav.value) return;
  nextTick(() => {
    const el = listRef.value?.querySelector(
      `[data-value="${CSS.escape(val)}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  });
});

onMounted(() => document.addEventListener("mousedown", handleClickOutside));
onBeforeUnmount(() =>
  document.removeEventListener("mousedown", handleClickOutside),
);
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full"
  >
    <!-- ── Trigger ──────────────────────────────────────────────── -->
    <button
      type="button"
      role="combobox"
      :aria-expanded="isOpen"
      tabindex="0"
      class="w-full flex items-center gap-2 bg-theme-900 border border-theme-600 text-theme-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-accent-500 cursor-pointer select-none"
      :class="currentSizeClasses.trigger"
      @click="toggle"
      @keydown="handleKeydown"
    >
      <!-- Icon / image -->
      <span class="shrink-0 w-4 h-4 flex items-center justify-center">
        <img
          v-if="selectedOption?.imgSrc"
          :src="selectedOption.imgSrc"
          class="w-4 h-4 object-contain rounded-sm"
          alt=""
        >
        <Icon
          v-else-if="selectedOption?.iconName"
          :icon="selectedOption.iconName"
          class="w-3.5 h-3.5 text-theme-400"
        />
        <Icon
          v-else
          :icon="placeholderIcon"
          class="w-3.5 h-3.5 text-theme-500"
        />
      </span>

      <!-- Label -->
      <span class="flex-1 text-left truncate">
        {{ selectedOption?.label ?? placeholder }}
      </span>

      <span
        v-if="showSelectedTag && selectedOption?.tagIconName"
        class="shrink-0 inline-flex items-center justify-center text-amber-400"
        :title="selectedOption.tag"
      >
        <Icon
          :icon="selectedOption.tagIconName"
          class="h-3.5 w-3.5"
        />
      </span>

      <span
        v-else-if="showSelectedTag && selectedOption?.tag"
        class="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full"
        :class="tagVariantClasses(selectedOption.tagVariant)"
      >
        {{ selectedOption.tag }}
      </span>

      <!-- Chevron -->
      <Icon
        icon="lucide:chevron-down"
        class="w-3 h-3 text-theme-500 shrink-0 transition-transform duration-150"
        :class="{ 'rotate-180': isOpen }"
      />
    </button>

    <!-- ── Dropdown panel ──────────────────────────────────────── -->
    <div
      v-if="isOpen"
      ref="listRef"
      role="listbox"
      class="absolute z-50 bg-theme-900 border border-theme-700 rounded-lg shadow-xl overflow-hidden"
      :class="[
        dropdownWidth,
        dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
        align === 'right'
          ? 'right-0'
          : align === 'center'
            ? 'left-1/2 -translate-x-1/2'
            : 'left-0',
      ]"
    >
      <!-- Filter input -->
      <div
        v-if="filterable"
        class="px-2 pt-2 pb-1"
      >
        <input
          ref="filterInputRef"
          v-model="filterQuery"
          type="text"
          placeholder="Search…"
          autocomplete="off"
          class="w-full bg-theme-700/60 border border-theme-600 rounded-md text-theme-200 placeholder:text-theme-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          :class="currentSizeClasses.filterInput"
          @keydown.esc.prevent="isOpen = false"
          @keydown.arrow-down.prevent="handleKeydown"
          @keydown.arrow-up.prevent="handleKeydown"
          @keydown.enter.prevent="handleKeydown"
        >
      </div>

      <div
        class="py-1 overflow-y-auto"
        :class="maxHeight"
      >
        <div
          v-if="filterable && filterQuery && !filteredAllOptions.length"
          class="px-3 py-2 text-theme-500 italic"
          :class="currentSizeClasses.empty"
        >
          No results
        </div>
        <template
          v-for="(group, gi) in filteredGroups"
          :key="gi"
        >
          <!-- Group header -->
          <div
            v-if="group.label"
            class="px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-wider text-theme-500"
            :class="[
              gi > 0 ? 'pt-2 border-t border-theme-800' : 'pt-1.5',
              props.stickyGroupHeaders ? 'select-group-header' : ''
            ]"
          >
            {{ group.label }}
          </div>

          <!-- Options -->
          <button
            v-for="opt in group.options"
            :key="opt.value"
            type="button"
            role="option"
            :aria-selected="opt.value === modelValue"
            :aria-disabled="opt.disabled"
            :disabled="opt.disabled"
            :title="opt.tooltip"
            :data-value="opt.value"
            class="group/select-option w-full flex items-center gap-2 cursor-pointer transition-colors"
            :class="[
              currentSizeClasses.option,
              opt.disabled
                ? 'text-theme-600 cursor-not-allowed'
                : opt.value === modelValue
                  ? 'text-theme-100'
                  : 'text-theme-300',
              opt.disabled
                ? ''
                : opt.value === focusedValue
                  ? 'bg-theme-700/80'
                  : opt.value === modelValue
                    ? 'bg-accent-600/15 hover:bg-accent-600/25'
                    : 'hover:bg-theme-800',
            ]"
            @click="selectOption(opt.value)"
            @mouseenter="!opt.disabled && (keyboardNav = false, focusedValue = opt.value)"
          >
            <!-- Icon / image -->
            <span
              v-if="hasOptionIcons"
              class="shrink-0 w-4 h-4 flex items-center justify-center"
            >
              <img
                v-if="opt.imgSrc"
                :src="opt.imgSrc"
                class="w-4 h-4 object-contain rounded-sm"
                alt=""
              >
              <Icon
                v-else-if="opt.iconName"
                :icon="opt.iconName"
                class="w-3.5 h-3.5"
                :class="opt.disabled ? 'text-theme-600' : 'text-theme-400'"
              />
            </span>

            <!-- Label -->
            <span class="flex-1 text-left truncate">{{ opt.label }}</span>

            <!-- Optional tag icon badge -->
            <span
              v-if="opt.tagIconName"
              class="shrink-0 inline-flex items-center justify-center text-amber-400"
              :title="opt.tag"
            >
              <Icon
                :icon="opt.tagIconName"
                class="h-3.5 w-3.5"
              />
            </span>

            <!-- Optional tag text badge -->
            <span
              v-else-if="opt.tag"
              class="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full"
              :class="tagVariantClasses(opt.tagVariant)"
            >
              {{ opt.tag }}
            </span>

            <!-- Optional row action -->
            <span
              v-if="opt.actionIconName"
              role="button"
              tabindex="-1"
              class="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-md transition-all"
              :class="[
                opt.actionActive
                  ? 'text-amber-400 opacity-100 hover:text-amber-300 [&>svg]:fill-current'
                  : 'text-theme-500 opacity-0 hover:text-amber-400 group-hover/select-option:opacity-100 group-focus-visible/select-option:opacity-100',
              ]"
              :title="opt.actionLabel"
              :aria-label="opt.actionLabel"
              @click.stop="triggerOptionAction(opt)"
            >
              <Icon
                :icon="opt.actionActive ? (opt.actionActiveIconName || opt.actionIconName) : opt.actionIconName"
                class="h-3.5 w-3.5"
              />
            </span>

            <!-- Check mark for currently selected value -->
            <Icon
              v-if="opt.value === modelValue"
              icon="lucide:check"
              class="w-3 h-3 text-accent-400 shrink-0"
            />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
@media (max-width: 767px) {
  .select-group-header {
    position: static;
  }
}

@media (min-width: 768px) {
  .select-group-header {
    position: sticky;
    top: -5px;
    z-index: 1;
    background: color-mix(in oklab, var(--color-theme-900) 97%, transparent);
    backdrop-filter: blur(2px);
  }
}
</style>
