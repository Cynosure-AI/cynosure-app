<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { AgentDefinition } from '../../api/client'
import { useProviderStore } from '../../stores/provider.store'
import { useChatStore } from '../../stores/chat.store'
import { useProviderLogos } from '../../composables/useProviderLogos'
import { Icon } from '@iconify/vue'

const props = defineProps<{ agents: AgentDefinition[] }>()
const emit = defineEmits<{ select: [agent: AgentDefinition] }>()

const providerStore = useProviderStore()
const chatStore = useChatStore()
const { logoUrl } = useProviderLogos()

const activeIdx = ref(0)

// When agents list arrives, jump to the last-used agent
watch(() => props.agents, (list) => {
  if (!list.length) return
  const lastId = chatStore.activeAgentId
  if (lastId) {
    const idx = list.findIndex(a => a.id === lastId)
    if (idx >= 0) activeIdx.value = idx
  }
}, { immediate: true })

const visibleRange = 4 // cards visible on each side (outermost ones are nearly transparent)

function prev(): void {
  activeIdx.value = (activeIdx.value - 1 + props.agents.length) % props.agents.length
}

function next(): void {
  activeIdx.value = (activeIdx.value + 1) % props.agents.length
}

function goTo(idx: number): void {
  activeIdx.value = idx
}

function agentIcon(agent: AgentDefinition): string | null {
  if (agent.iconUrl) return agent.iconUrl
  const prov = providerStore.providers.find(p => p.id === agent.providerId)
  return prov ? logoUrl(prov.type) : null
}

const cards = computed(() => {
  const n = props.agents.length
  if (n === 0) return []

  return props.agents.map((agent, i) => {
    let diff = i - activeIdx.value
    if (diff > n / 2) diff -= n
    if (diff < -n / 2) diff += n

    const absD = Math.abs(diff)
    const visible = absD <= visibleRange

    // Wider spacing so the larger cards don't overlap too tightly
    const xPercent = diff * 48
    // Active card at 1.0, side cards shrink more aggressively for depth contrast
    const scale = diff === 0 ? 1 : Math.max(0.48, 0.82 - (absD - 1) * 0.13)
    const opacity = visible ? Math.max(0, 1 - absD * 0.28) : 0
    const zIndex = 100 - absD

    return {
      agent,
      index: i,
      visible,
      isActive: diff === 0,
      style: {
        transform: `translateX(${xPercent}%) scale(${scale})`,
        opacity,
        zIndex,
        filter: absD > 0 ? `blur(${Math.min(absD * 0.6, 2)}px)` : 'none',
        pointerEvents: visible ? 'auto' : 'none',
      } as Record<string, string | number>,
    }
  })
})

function onCardClick(card: typeof cards.value[number]): void {
  if (card.isActive) {
    emit('select', card.agent)
  } else {
    goTo(card.index)
  }
}

function selectActive(): void {
  const active = props.agents[activeIdx.value]
  if (active) emit('select', active)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
  else if (e.key === 'ArrowRight') { e.preventDefault(); next() }
  else if (e.key === 'Enter') { e.preventDefault(); selectActive() }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.deltaY > 0 || e.deltaX > 0) next()
  else if (e.deltaY < 0 || e.deltaX < 0) prev()
}
</script>

<template>
  <div
    v-if="agents.length"
    class="relative select-none outline-none isolate"
    tabindex="0"
    @keydown="onKeydown"
    @wheel.prevent="onWheel"
  >
    <!-- Stage -->
    <div class="carousel-stage relative flex items-center justify-center overflow-hidden">
      <div
        v-for="card in cards"
        :key="card.agent.id"
        class="carousel-card absolute rounded-2xl border cursor-pointer overflow-hidden"
        :class="[
          card.isActive
            ? 'border-blue-500/70 bg-white dark:bg-zinc-800 shadow-2xl shadow-blue-500/20'
            : 'border-zinc-200 dark:border-zinc-700/60 bg-zinc-50 dark:bg-zinc-900/80',
        ]"
        :style="card.style"
        @click="onCardClick(card)"
      >
        <!-- Agent icon -->
        <div class="flex items-center justify-center pt-7 pb-3">
          <div
            class="rounded-2xl flex items-center justify-center overflow-hidden icon-wrap"
            :class="card.isActive
              ? 'bg-zinc-100 dark:bg-zinc-700/60 ring-2 ring-blue-500/30'
              : 'bg-zinc-100 dark:bg-zinc-800/80'"
          >
            <img
              v-if="agentIcon(card.agent)"
              :src="agentIcon(card.agent)!"
              :alt="card.agent.name"
              class="object-contain rounded-xl agent-img"
            >
            <Icon
              v-else
              icon="lucide:bot"
              class="text-icon"
              :class="card.isActive ? 'text-blue-400' : 'text-zinc-400 dark:text-zinc-500'"
            />
          </div>
        </div>

        <!-- Agent name -->
        <div class="px-4 text-center">
          <p
            class="font-semibold truncate agent-name"
            :class="card.isActive
              ? 'text-zinc-900 dark:text-zinc-100'
              : 'text-zinc-500 dark:text-zinc-400'"
          >
            {{ card.agent.name }}
          </p>
          <p
            v-if="card.agent.description"
            class="mt-1 line-clamp-2 leading-snug agent-desc"
            :class="card.isActive
              ? 'text-zinc-500 dark:text-zinc-400'
              : 'text-zinc-400 dark:text-zinc-600'"
          >
            {{ card.agent.description }}
          </p>
        </div>

        <!-- Chat hint on active card -->
        <div
          v-if="card.isActive"
          class="absolute bottom-3 inset-x-0 flex justify-center"
        >
          <span class="flex items-center gap-1.5 text-xs text-blue-500/90 dark:text-blue-400/80 font-medium">
            <Icon
              icon="lucide:message-square"
              class="w-3.5 h-3.5"
            />
            Click to chat
          </span>
        </div>
      </div>
    </div>

    <!-- Navigation arrows -->
    <button
      v-if="agents.length > 1"
      class="absolute left-0 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white dark:bg-zinc-800/90 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors z-110"
      @click="prev"
    >
      <Icon
        icon="lucide:chevron-left"
        class="w-4 h-4"
      />
    </button>
    <button
      v-if="agents.length > 1"
      class="absolute right-0 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white dark:bg-zinc-800/90 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors z-110"
      @click="next"
    >
      <Icon
        icon="lucide:chevron-right"
        class="w-4 h-4"
      />
    </button>

    <!-- Dot indicators -->
    <div
      v-if="agents.length > 1"
      class="flex justify-center gap-1.5 mt-3"
    >
      <button
        v-for="(agent, i) in agents"
        :key="agent.id"
        class="h-1.5 rounded-full transition-all duration-300"
        :class="i === activeIdx
          ? 'bg-blue-500 w-5'
          : 'bg-zinc-300 dark:bg-zinc-600 hover:bg-zinc-400 dark:hover:bg-zinc-500 w-1.5'"
        @click="goTo(i)"
      />
    </div>
  </div>
</template>

<style scoped>
.carousel-stage {
  /* Taller stage to accommodate larger cards */
  height: 320px;
}

.carousel-card {
  /* Larger card footprint */
  width: 220px;
  height: 260px;
  transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.45s cubic-bezier(0.4, 0, 0.2, 1),
              filter 0.45s cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 0.45s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Icon container — larger on active card */
.icon-wrap {
  width: 88px;
  height: 88px;
}

.agent-img {
  width: 68px;
  height: 68px;
}

.text-icon {
  width: 40px;
  height: 40px;
}

.agent-name {
  font-size: 0.875rem; /* 14px */
}

.agent-desc {
  font-size: 0.75rem; /* 12px */
}
</style>
