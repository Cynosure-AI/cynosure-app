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
}

export interface SelectOptionGroup {
  /** Shown as a group header; omit for ungrouped options */
  label?: string;
  options: SelectOption[];
}

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
    /**
     * Trigger button size:
     * - 'sm' — compact (text-xs, py-1.5, px-2.5) for toolbars/headers
     * - 'md' — standard form size (text-sm, py-2, px-3)
     */
    size?: "sm" | "md";
  }>(),
  {
    placeholder: "Select...",
    placeholderIcon: "lucide:chevrons-up-down",
    maxHeight: "max-h-56",
    dropdownWidth: "w-full",
    dropUp: false,
    stickyGroupHeaders: false,
    align: "left",
    size: "sm",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
}>();

const isOpen = ref(false);
const containerRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const filterInputRef = ref<HTMLInputElement | null>(null);
/** Which option is keyboard-focused (by value) */
const focusedValue = ref<string>("");
const filterQuery = ref("");

const allOptions = computed(() => props.groups.flatMap((g) => g.options));
const selectedOption = computed(
  () => allOptions.value.find((o) => o.value === props.modelValue) ?? null,
);

/** Fuzzy match: true if all query chars appear in text in order (case-insensitive) */
function fuzzyMatch(text: string, query: string): boolean {
  const textLower = text.toLowerCase().replace(/\s+/g, "");
  const queryLower = query.toLowerCase().replace(/\s+/g, "");
  let queryIdx = 0;
  for (let i = 0; i < textLower.length && queryIdx < queryLower.length; i++) {
    if (textLower[i] === queryLower[queryIdx]) {
      queryIdx++;
    }
  }
  return queryIdx === queryLower.length;
}

const filteredGroups = computed(() => {
  if (!props.filterable || !filterQuery.value.trim()) return props.groups;
  const q = filterQuery.value;
  return props.groups
    .map((g) => ({
      ...g,
      options: g.options.filter((o) => fuzzyMatch(o.label, q)),
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

function open(): void {
  filterQuery.value = "";
  isOpen.value = true;
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
      focusedValue.value =
        nextEnabledOption(opts, idx, 1)?.value || focusedValue.value;
      break;
    case "ArrowUp":
      e.preventDefault();
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

/** Scroll keyboard-focused item into view */
watch(focusedValue, (val) => {
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
      class="w-full flex items-center gap-2 bg-zinc-900 border border-zinc-600 text-zinc-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer select-none"
      :class="size === 'md' ? 'text-sm px-3 py-2' : 'text-xs px-2.5 py-1.5'"
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
          class="w-3.5 h-3.5 text-zinc-400"
        />
        <Icon
          v-else
          :icon="placeholderIcon"
          class="w-3.5 h-3.5 text-zinc-500"
        />
      </span>

      <!-- Label -->
      <span class="flex-1 text-left truncate">
        {{ selectedOption?.label ?? placeholder }}
      </span>

      <!-- Chevron -->
      <Icon
        icon="lucide:chevron-down"
        class="w-3 h-3 text-zinc-500 shrink-0 transition-transform duration-150"
        :class="{ 'rotate-180': isOpen }"
      />
    </button>

    <!-- ── Dropdown panel ──────────────────────────────────────── -->
    <div
      v-if="isOpen"
      ref="listRef"
      role="listbox"
      class="absolute z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden"
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
          class="w-full bg-zinc-700/60 border border-zinc-600 rounded-md px-2.5 py-1 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
          class="px-3 py-2 text-xs text-zinc-500 italic"
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
            class="px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500"
            :class="[
              gi > 0 ? 'pt-2 border-t border-zinc-800' : 'pt-1.5',
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
            class="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer transition-colors"
            :class="[
              opt.disabled
                ? 'text-zinc-600 cursor-not-allowed'
                : opt.value === modelValue
                  ? 'text-zinc-100'
                  : 'text-zinc-300',
              opt.disabled
                ? ''
                : opt.value === focusedValue
                  ? 'bg-zinc-700/80'
                  : opt.value === modelValue
                    ? 'bg-blue-600/15 hover:bg-blue-600/25'
                    : 'hover:bg-zinc-800',
            ]"
            @click="selectOption(opt.value)"
            @mouseenter="!opt.disabled && (focusedValue = opt.value)"
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
                :class="opt.disabled ? 'text-zinc-600' : 'text-zinc-400'"
              />
            </span>

            <!-- Label -->
            <span class="flex-1 text-left truncate">{{ opt.label }}</span>

            <!-- Optional tag badge -->
            <span
              v-if="opt.tag"
              class="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400"
            >
              {{ opt.tag }}
            </span>

            <!-- Check mark for currently selected value -->
            <Icon
              v-if="opt.value === modelValue"
              icon="lucide:check"
              class="w-3 h-3 text-blue-400 shrink-0"
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
    background: color-mix(in oklab, var(--color-zinc-900) 97%, transparent);
    backdrop-filter: blur(2px);
  }
}
</style>
