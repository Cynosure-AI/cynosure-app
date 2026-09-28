<template>
  <div class="flex min-h-full w-full items-center justify-center px-4 py-5 sm:px-7 sm:py-8">
    <section
      class="w-full max-w-6xl"
      aria-labelledby="welcome-title"
    >
      <div class="mx-auto flex max-w-5xl flex-col items-center text-center">
        <div class="welcome-logo-wrap mb-5">
          <span class="welcome-logo-ring welcome-logo-ring--outer" />
          <span class="welcome-logo-ring welcome-logo-ring--inner" />
          <div class="welcome-logo">
            <img
              :src="logoIconUrl"
              alt=""
              class="h-14 w-14 object-contain"
            >
          </div>
        </div>

        <p class="welcome-eyebrow mb-3">
          Your personal AI workspace
        </p>
        <h1
          id="welcome-title"
          class="text-3xl font-semibold tracking-tight text-theme-100 sm:text-4xl"
        >
          Welcome to <span class="text-accent-fg">Cynosure</span>
        </h1>
        <p class="mt-3 max-w-2xl text-sm leading-6 text-theme-400 sm:text-base">
          Bring your models, tools, and knowledge together. Build capable agents that remember context and work the way you do.
        </p>

        <div class="mt-8 grid w-full gap-3 text-left sm:grid-cols-2 lg:grid-cols-4">
          <article
            v-for="feature in features"
            :key="feature.title"
            class="welcome-feature"
          >
            <div class="welcome-feature-icon">
              <Icon
                :icon="feature.icon"
                class="h-5 w-5"
              />
            </div>
            <div>
              <h2 class="text-sm font-semibold text-theme-100">
                {{ feature.title }}
              </h2>
              <p class="mt-1.5 text-xs leading-5 text-theme-500">
                {{ feature.description }}
              </p>
            </div>
          </article>
        </div>

        <div class="welcome-next-hint mt-7 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-theme-500">
          <Icon
            icon="lucide:sparkles"
            class="h-3.5 w-3.5 text-accent-fg"
          />
          A quick guided setup — you can change everything later
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useAppBranding } from '../../composables/useAppBranding'

const { logoIconUrl } = useAppBranding()

const features = [
  {
    title: 'Chat & Assist',
    description: 'Work with your preferred AI models in one focused space.',
    icon: 'lucide:messages-square',
  },
  {
    title: 'Build Agents',
    description: 'Create specialists with their own roles, tools, and behaviour.',
    icon: 'lucide:bot',
  },
  {
    title: 'Connect Tools',
    description: 'Connect search, files, services, and the apps you rely on.',
    icon: 'lucide:wrench',
  },
  {
    title: 'Add Memory',
    description: 'Give agents durable knowledge and useful long-term context.',
    icon: 'lucide:database',
  },
]
</script>

<style scoped>
.welcome-logo-wrap {
  position: relative;
  display: grid;
  width: 7rem;
  height: 7rem;
  place-items: center;
}

.welcome-logo-ring {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 33%, transparent);
  border-radius: 9999px;
}

.welcome-logo-ring--outer {
  inset: 0;
  box-shadow: inset 0 0 28px color-mix(in srgb, var(--color-accent-500) 5%, transparent);
}

.welcome-logo-ring--inner {
  inset: .5rem;
  border-color: color-mix(in srgb, var(--color-accent-400) 24%, transparent);
}

.welcome-logo {
  display: grid;
  width: 4.25rem;
  height: 4.25rem;
  place-items: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent-400) 40%, transparent);
  border-radius: 1.25rem;
  background: radial-gradient(circle at 35% 25%, color-mix(in srgb, var(--color-accent-400) 24%, transparent), color-mix(in srgb, var(--color-theme-900) 93%, transparent));
  box-shadow: 0 0 30px color-mix(in srgb, var(--color-accent-500) 20%, transparent), inset 0 1px 0 color-mix(in srgb, var(--color-theme-100) 12%, transparent);
}

.welcome-eyebrow {
  color: var(--color-accent-300);
  font-size: .6875rem;
  font-weight: 650;
  letter-spacing: .16em;
  text-transform: uppercase;
}

.welcome-feature {
  display: flex;
  min-width: 0;
  gap: .875rem;
  padding: 1.125rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 38%, transparent);
  border-radius: .875rem;
  background: linear-gradient(145deg, color-mix(in srgb, var(--color-theme-800) 58%, transparent), color-mix(in srgb, var(--color-theme-900) 52%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-theme-100) 4%, transparent);
  backdrop-filter: blur(8px);
}

.welcome-feature-icon {
  display: grid;
  flex: 0 0 auto;
  width: 2.75rem;
  height: 2.75rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 35%, transparent);
  border-radius: 9999px;
  background: color-mix(in srgb, var(--color-accent-500) 12%, transparent);
  color: var(--color-accent-300);
}

.welcome-next-hint {
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 28%, transparent);
  background: color-mix(in srgb, var(--color-theme-900) 45%, transparent);
}

@media (max-width: 639px) {
  .welcome-feature {
    padding: 1rem;
  }
}
</style>
