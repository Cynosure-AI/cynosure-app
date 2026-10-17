<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { documentThumbnailHref, documentTypeStyle } from '../../utils/document-types'

const props = defineProps<{
  ext: string
  /** The file's `/api/files` href; enables the server-rendered thumbnail where supported. */
  href?: string
  compact?: boolean
}>()

const style = computed(() => documentTypeStyle(props.ext))
const thumbnailHref = computed(() => props.href ? documentThumbnailHref(props.href, props.ext) : null)
const thumbnailLoaded = ref(false)
const thumbnailFailed = ref(false)

watch(thumbnailHref, () => {
  thumbnailLoaded.value = false
  thumbnailFailed.value = false
})

// Relative widths for the sketched page content.
const textLines = [100, 92, 96, 70, 88, 94, 60]
const codeLines: [indent: number, width: number][] = [[0, 30], [12, 62], [12, 48], [24, 54], [12, 40], [0, 18]]
const tableRows = 5
const tableColumns = 3
</script>

<template>
  <div
    class="doc-art relative flex h-full w-full items-center justify-center overflow-hidden"
    :class="style.tint"
  >
    <div
      class="doc-page relative"
      :class="[
        style.shape === 'slide' ? 'aspect-4/3' : 'aspect-3/4',
        style.shape === 'slide'
          ? (compact ? 'w-[64%]' : 'w-[58%]')
          : (compact ? 'w-[44%]' : 'w-[38%]'),
      ]"
    >
      <!-- The fold's clip-path lives on this inner layer so the badge isn't clipped. -->
      <div
        class="absolute inset-0 flex flex-col bg-zinc-50 p-[12%]"
        :class="[
          compact ? 'gap-[3px] rounded-[3px]' : 'gap-[6%] rounded-md',
          { 'doc-page-folded': style.shape !== 'slide' },
        ]"
      >
        <template v-if="style.shape === 'lines'">
          <div
            class="h-[7%] w-1/2 shrink-0 rounded-full opacity-80"
            :class="style.fill"
          />
          <div
            v-for="(width, index) in (compact ? textLines.slice(0, 4) : textLines)"
            :key="index"
            class="h-[3.5%] shrink-0 rounded-full bg-zinc-300"
            :style="{ width: `${width}%` }"
          />
        </template>

        <div
          v-else-if="style.shape === 'table'"
          class="grid flex-1 gap-[3px]"
          :style="{ gridTemplateColumns: `repeat(${tableColumns}, minmax(0, 1fr))` }"
        >
          <div
            v-for="cell in tableColumns"
            :key="`head-${cell}`"
            class="rounded-[2px] opacity-80"
            :class="style.fill"
          />
          <div
            v-for="cell in tableColumns * (compact ? 3 : tableRows)"
            :key="cell"
            class="rounded-[2px] bg-zinc-200"
          />
        </div>

        <template v-else-if="style.shape === 'slide'">
          <div
            class="h-[11%] w-3/5 shrink-0 rounded-full opacity-80"
            :class="style.fill"
          />
          <div class="flex min-h-0 flex-1 gap-[8%]">
            <div class="flex flex-1 flex-col justify-center gap-[12%]">
              <div
                v-for="width in [90, 75, 82]"
                :key="width"
                class="h-[9%] rounded-full bg-zinc-300"
                :style="{ width: `${width}%` }"
              />
            </div>
            <div
              class="flex-1 rounded-[3px] opacity-25"
              :class="style.fill"
            />
          </div>
        </template>

        <template v-else-if="style.shape === 'code'">
          <div
            v-for="([indent, width], index) in (compact ? codeLines.slice(0, 4) : codeLines)"
            :key="index"
            class="h-[4%] shrink-0 rounded-full"
            :class="index === 0 || index === codeLines.length - 1 ? [style.fill, 'opacity-80'] : 'bg-zinc-300'"
            :style="{ marginLeft: `${indent}%`, width: `${width}%` }"
          />
        </template>

        <div
          v-else-if="style.shape === 'archive'"
          class="flex flex-1 flex-col items-center"
        >
          <div
            v-for="tooth in (compact ? 5 : 9)"
            :key="tooth"
            class="h-[6%] w-[16%] shrink-0 opacity-70"
            :class="[style.fill, tooth % 2 ? '-translate-x-1/2' : 'translate-x-1/2']"
          />
          <div
            class="mt-[6%] aspect-square w-[22%] rounded-[3px] border-2 border-zinc-400"
          />
        </div>
      </div>

      <div
        class="absolute flex items-center justify-center text-white shadow-lg shadow-black/25"
        :class="[style.fill, compact ? '-bottom-1.5 -right-1.5 h-5 w-5 rounded-md' : '-bottom-3 -right-3 h-10 w-10 rounded-xl']"
      >
        <Icon
          :icon="style.icon"
          :class="compact ? 'h-3.5 w-3.5' : 'h-6 w-6'"
        />
      </div>
    </div>

    <img
      v-if="thumbnailHref && !thumbnailFailed"
      :src="thumbnailHref"
      alt=""
      loading="lazy"
      class="absolute inset-0 h-full w-full bg-white object-cover object-top transition-opacity duration-300"
      :class="thumbnailLoaded ? 'opacity-100' : 'opacity-0'"
      @load="thumbnailLoaded = true"
      @error="thumbnailFailed = true"
    >
  </div>
</template>

<style scoped>
.doc-page-folded {
  clip-path: polygon(0 0, 78% 0, 100% 16.5%, 100% 100%, 0 100%);
}

.doc-page-folded::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 22%;
  height: 16.5%;
  border-bottom-left-radius: 3px;
  background: linear-gradient(to bottom left, transparent 50%, rgb(0 0 0 / 0.12) 50%);
}

/* drop-shadow (unlike box-shadow) follows the folded outline and the badge. */
.doc-page {
  filter: drop-shadow(0 6px 10px rgb(0 0 0 / 0.18)) drop-shadow(0 0 1px rgb(0 0 0 / 0.2));
}

:global([data-theme="monochrome"]) .doc-art {
  filter: grayscale(1);
}
</style>
