<template>
  <div class="max-w-4xl mx-auto px-4 py-8 w-full">
    <!-- HERO -->
    <div
      class="hero-card relative overflow-hidden rounded-[28px] border border-accent-500/25 mb-7"
    >
      <!-- Background layers -->
      <div class="hero-grid absolute inset-0 pointer-events-none" />
      <div class="hero-noise absolute inset-0 pointer-events-none" />

      <!-- Glow blobs -->
      <div
        class="absolute -right-20 -top-24 w-80 h-80 rounded-full pointer-events-none hero-blob hero-blob-gold"
      />
      <div
        class="absolute -left-20 -bottom-24 w-72 h-72 rounded-full pointer-events-none hero-blob hero-blob-teal"
      />
      <div
        class="absolute left-1/2 top-1/2 w-72 h-72 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none hero-blob hero-blob-soft"
      />

      <div class="relative p-7 sm:p-9">
        <div class="flex flex-col sm:flex-row items-center sm:items-start gap-6">
          <!-- Logo -->
          <div class="logo-wrap relative shrink-0 w-[82px] h-[82px]">
            <div class="logo-ring-outer absolute -inset-4 rounded-[28px]" />
            <div class="logo-ring absolute -inset-2 rounded-[24px]" />

            <div class="relative logo-tile w-[82px] h-[82px] rounded-[22px] flex items-center justify-center">
              <img
                :src="logoIconUrl"
                alt="Cynosure"
                class="w-14 h-14 object-contain drop-shadow-md"
              >
            </div>
          </div>

          <div class="text-center sm:text-left flex-1">
            <div class="inline-flex items-center gap-2 mb-3 rounded-full border border-accent-500/20 bg-accent-500/[0.07] px-3 py-1">
              <span class="eyebrow-dot w-[6px] h-[6px] rounded-full bg-accent-400 shrink-0" />
              <span class="text-[10px] font-bold uppercase tracking-[0.18em] text-accent-300">
                Your personal AI workspace
              </span>
            </div>

            <h1 class="text-[34px] sm:text-[40px] font-extrabold tracking-tight leading-[1.05] text-theme-100 mb-3">
              Welcome to
              <span class="hero-gradient-text">Cynosure</span>
            </h1>

            <p class="text-[14px] sm:text-[15px] text-theme-400 leading-relaxed max-w-2xl mb-5">
              Create agents that actually do useful work: connect models, give them tools,
              add memory, and let them help through chats, schedules, files, and connected services.
            </p>

            <!-- Capability pills -->
            <div class="flex flex-wrap justify-center sm:justify-start gap-2">
              <div
                v-for="pill in pills"
                :key="pill.label"
                class="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-theme-400"
              >
                <Icon
                  :icon="pill.icon"
                  class="w-3.5 h-3.5 text-accent-400"
                />
                {{ pill.label }}
              </div>
            </div>
          </div>
        </div>

        <!-- Soft guide strip -->
        <div class="mt-7 grid sm:grid-cols-3 gap-2.5">
          <div
            v-for="step in introSteps"
            :key="step.title"
            class="intro-step rounded-2xl border border-white/[0.07] bg-white/[0.035] px-4 py-3"
          >
            <div class="flex items-center gap-2 mb-1">
              <span class="step-number flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold">
                {{ step.number }}
              </span>
              <p class="text-[12px] font-semibold text-theme-200">
                {{ step.title }}
              </p>
            </div>
            <p class="text-[11px] text-theme-600 leading-relaxed">
              {{ step.description }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <div class="h-full flex flex-col items-center justify-center gap-6 ">
      <!-- SECTION LABEL -->
      <div class="flex items-center gap-2.5 mb-3.5">
        <span class="text-[10px] font-bold uppercase tracking-[0.18em] text-theme-600">
          Start building with
        </span>
        <div class="section-line flex-1 h-px" />
      </div>

      <!-- FEATURE GRID -->
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div
          v-for="feature in features"
          :key="feature.title"
          class="feature-card group relative overflow-hidden rounded-[18px] border p-4.5 transition-all duration-300 hover:-translate-y-1"
          :class="feature.cardBorder"
          :style="{ '--feature-glow': feature.glowColor, '--feature-glow-strong': feature.glowColorStrong }"
        >
          <!-- Default gradient glow -->
          <div class="feature-glow absolute inset-0 rounded-[18px] pointer-events-none" />

          <!-- Hover sheen -->
          <div class="feature-sheen absolute inset-0 rounded-[18px] pointer-events-none" />

          <div class="relative">
            <div class="flex items-start justify-between gap-3 mb-4">
              <div
                class="feature-icon w-10 h-10 rounded-[12px] flex items-center justify-center border"
                :class="[feature.iconBg, feature.iconBorder]"
              >
                <Icon
                  :icon="feature.icon"
                  class="w-[18px] h-[18px]"
                  :class="feature.iconColor"
                />
              </div>

              <Icon
                icon="lucide:arrow-up-right"
                class="feature-arrow w-4 h-4 text-theme-700 transition-all duration-300 group-hover:text-theme-400 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
              />
            </div>

            <p class="text-[13px] font-bold text-theme-150 mb-1.5 leading-snug">
              {{ feature.title }}
            </p>

            <p class="text-[11.5px] text-theme-550 leading-relaxed">
              {{ feature.description }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useAppBranding } from '../../composables/useAppBranding'

const { logoIconUrl } = useAppBranding()

const pills = [
  {
    label: 'Agents',
    icon: 'lucide:bot',
  },
  {
    label: 'Memory',
    icon: 'lucide:brain',
  },
  {
    label: 'Tools',
    icon: 'lucide:wrench',
  },
  {
    label: 'Automations',
    icon: 'lucide:calendar-clock',
  },
]

const introSteps = [
  {
    number: '1',
    title: 'Pick a model',
    description: 'Use cloud or local providers depending on the task.',
  },
  {
    number: '2',
    title: 'Create an agent',
    description: 'Give it instructions, tools, memory, and boundaries.',
  },
  {
    number: '3',
    title: 'Let it work',
    description: 'Chat, schedule runs, or connect it to your workflows.',
  },
]

const features = [
  {
    title: 'Chat with any model',
    description: 'Connect cloud or local AI providers and switch models whenever you need.',
    icon: 'lucide:messages-square',
    iconBg: 'bg-teal-500/15',
    iconBorder: 'border-teal-500/25',
    iconColor: 'text-teal-400',
    cardBorder: 'border-teal-500/20 hover:border-teal-500/45',
    glowColor: 'rgba(20,184,166,0.105)',
    glowColorStrong: 'rgba(20,184,166,0.18)',
  },
  {
    title: 'Build specialized agents',
    description: 'Create reusable agents with their own prompts, models, tools, and permissions.',
    icon: 'lucide:bot',
    iconBg: 'bg-amber-500/15',
    iconBorder: 'border-amber-500/25',
    iconColor: 'text-amber-400',
    cardBorder: 'border-amber-500/20 hover:border-amber-500/45',
    glowColor: 'rgba(251,191,36,0.105)',
    glowColorStrong: 'rgba(251,191,36,0.18)',
  },
  {
    title: 'Connect MCP tools',
    description: 'Add web search, files, email, desktop control, and many more capabilities.',
    icon: 'lucide:plug-zap',
    iconBg: 'bg-purple-500/15',
    iconBorder: 'border-purple-500/25',
    iconColor: 'text-purple-400',
    cardBorder: 'border-purple-500/20 hover:border-purple-500/45',
    glowColor: 'rgba(168,85,247,0.105)',
    glowColorStrong: 'rgba(168,85,247,0.18)',
  },
  {
    title: 'Remember your knowledge',
    description: 'Index documents and conversations into searchable, long-term memory spaces.',
    icon: 'lucide:brain',
    iconBg: 'bg-emerald-500/15',
    iconBorder: 'border-emerald-500/25',
    iconColor: 'text-emerald-400',
    cardBorder: 'border-emerald-500/20 hover:border-emerald-500/45',
    glowColor: 'rgba(16,185,129,0.105)',
    glowColorStrong: 'rgba(16,185,129,0.18)',
  },
  {
    title: 'Automate recurring work',
    description: 'Run agents on schedules and keep an eye on active or completed executions.',
    icon: 'lucide:calendar-clock',
    iconBg: 'bg-cyan-500/15',
    iconBorder: 'border-cyan-500/25',
    iconColor: 'text-cyan-400',
    cardBorder: 'border-cyan-500/20 hover:border-cyan-500/45',
    glowColor: 'rgba(6,182,212,0.105)',
    glowColorStrong: 'rgba(6,182,212,0.18)',
  },
  {
    title: 'Work across channels',
    description: 'Bring agents into connected services and receive useful notifications.',
    icon: 'lucide:radio',
    iconBg: 'bg-rose-500/15',
    iconBorder: 'border-rose-500/25',
    iconColor: 'text-rose-400',
    cardBorder: 'border-rose-500/20 hover:border-rose-500/45',
    glowColor: 'rgba(244,63,94,0.105)',
    glowColorStrong: 'rgba(244,63,94,0.18)',
  },
]
</script>

<style scoped>
.hero-card {
  background:
    radial-gradient(circle at 80% 0%, rgba(209, 178, 56, 0.14) 0%, transparent 34%),
    radial-gradient(circle at 0% 100%, rgba(20, 184, 166, 0.1) 0%, transparent 32%),
    linear-gradient(135deg, rgba(22, 23, 28, 0.98) 0%, rgba(12, 13, 16, 0.99) 100%);
  box-shadow:
    0 24px 80px rgba(0, 0, 0, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.045);
}

/* Hero background grid */
.hero-grid {
  background-image:
    linear-gradient(rgba(209, 178, 56, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(209, 178, 56, 0.045) 1px, transparent 1px);
  background-size: 34px 34px;
  mask-image: radial-gradient(ellipse 85% 70% at 50% 5%, black 28%, transparent 100%);
}

/* Very subtle texture */
.hero-noise {
  background:
    linear-gradient(120deg, rgba(255, 255, 255, 0.035), transparent 30%, rgba(255, 255, 255, 0.018));
  opacity: 0.7;
}

.hero-blob {
  filter: blur(2px);
  animation: heroPulse 5s ease-in-out infinite;
}

.hero-blob-gold {
  background: radial-gradient(circle, rgba(209, 178, 56, 0.2) 0%, transparent 68%);
}

.hero-blob-teal {
  background: radial-gradient(circle, rgba(20, 184, 166, 0.12) 0%, transparent 70%);
  animation-delay: 0.8s;
}

.hero-blob-soft {
  background: radial-gradient(circle, rgba(255, 255, 255, 0.04) 0%, transparent 72%);
  animation-delay: 1.4s;
}

/* Logo */
.logo-tile {
  background:
    radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.12), transparent 34%),
    linear-gradient(135deg, rgba(209, 178, 56, 0.24) 0%, rgba(209, 178, 56, 0.08) 100%);
  border: 1px solid rgba(209, 178, 56, 0.34);
  box-shadow:
    0 0 28px rgba(209, 178, 56, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.logo-ring {
  border: 1px solid rgba(209, 178, 56, 0.26);
  animation: ringPulse 3.2s ease-in-out infinite;
}

.logo-ring-outer {
  border: 1px solid rgba(209, 178, 56, 0.11);
  animation: ringPulse 3.2s ease-in-out 0.5s infinite;
}

/* Gradient text */
.hero-gradient-text {
  background: linear-gradient(90deg, #d1b238 0%, #f8dd78 45%, #14b8a6 100%);
  background-size: 220% auto;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: shimmer 5s linear infinite;
}

.eyebrow-dot {
  box-shadow: 0 0 10px currentColor;
  animation: blink 2s ease-in-out infinite;
}

.intro-step {
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
}

.step-number {
  color: rgb(var(--color-accent-300, 240 208 96));
  background: rgba(209, 178, 56, 0.12);
  border: 1px solid rgba(209, 178, 56, 0.22);
}

.section-line {
  background: linear-gradient(90deg, rgba(75, 85, 99, 0.42) 0%, transparent 100%);
}

/* Feature cards */
.feature-card {
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.045) 0%, rgba(255, 255, 255, 0.018) 100%);
  box-shadow:
    0 14px 38px rgba(0, 0, 0, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.035);
}

.feature-card:hover {
  box-shadow:
    0 20px 52px rgba(0, 0, 0, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.055);
}

.feature-glow {
  opacity: 1;
  background:
    radial-gradient(circle at 0% 0%, var(--feature-glow) 0%, transparent 58%),
    linear-gradient(135deg, var(--feature-glow) 0%, transparent 42%);
  transition:
    opacity 300ms ease,
    background 300ms ease,
    transform 300ms ease;
}

.feature-card:hover .feature-glow {
  background:
    radial-gradient(circle at 0% 0%, var(--feature-glow-strong) 0%, transparent 62%),
    linear-gradient(135deg, var(--feature-glow-strong) 0%, transparent 48%);
  transform: scale(1.04);
}

.feature-sheen {
  opacity: 0;
  background: linear-gradient(
    120deg,
    transparent 0%,
    rgba(255, 255, 255, 0.055) 42%,
    transparent 70%
  );
  transform: translateX(-60%);
  transition:
    opacity 300ms ease,
    transform 500ms ease;
}

.feature-card:hover .feature-sheen {
  opacity: 1;
  transform: translateX(60%);
}

.feature-icon {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.055),
    0 8px 20px rgba(0, 0, 0, 0.18);
}

.feature-arrow {
  opacity: 0.45;
}

.feature-card:hover .feature-arrow {
  opacity: 1;
}

@keyframes heroPulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }

  50% {
    opacity: 0.72;
    transform: scale(1.06);
  }
}

@keyframes ringPulse {
  0%, 100% {
    opacity: 0.68;
    transform: scale(1);
  }

  50% {
    opacity: 0.24;
    transform: scale(1.04);
  }
}

@keyframes blink {
  0%, 100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

@keyframes shimmer {
  0% {
    background-position: 220% center;
  }

  100% {
    background-position: -220% center;
  }
}
</style>
