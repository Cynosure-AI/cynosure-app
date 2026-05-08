<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- ── Header / breadcrumb ─────────────────────────────────────── -->
    <div class="shrink-0 px-6 pt-5 pb-4 border-b border-zinc-800/60">
      <div class="max-w-2xl mx-auto flex items-center justify-between">
        <!-- Step breadcrumbs (hidden on welcome/done) -->
        <div
          v-if="showBreadcrumb"
          class="flex items-center gap-1"
        >
          <template
            v-for="(step, index) in breadcrumbSteps"
            :key="step.id"
          >
            <!-- Connector -->
            <div
              v-if="index > 0"
              class="w-8 h-px transition-colors duration-300"
              :class="breadcrumbStepIndex > index - 1 ? 'bg-blue-500' : 'bg-zinc-700'"
            />
            <!-- Step circle -->
            <button
              class="flex flex-col items-center gap-1 group"
              @click="jumpToStep(step.globalIndex)"
            >
              <div
                class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all duration-200"
                :class="stepCircleClass(index)"
              >
                <Icon
                  v-if="breadcrumbStepIndex > index"
                  icon="lucide:check"
                  class="w-3.5 h-3.5"
                />
                <span v-else>{{ index + 1 }}</span>
              </div>
              <span
                class="text-[10px] font-medium transition-colors duration-200 hidden sm:block"
                :class="breadcrumbStepIndex === index ? 'text-zinc-200' : breadcrumbStepIndex > index ? 'text-zinc-400' : 'text-zinc-600'"
              >{{ step.label }}</span>
            </button>
          </template>
        </div>
        <div
          v-else-if="currentStep === STEP_DONE"
          class="flex items-center gap-2 text-emerald-400"
        >
          <Icon
            icon="lucide:check-circle-2"
            class="w-5 h-5"
          />
          <span class="text-sm font-semibold">All set!</span>
        </div>
        <div v-else />

        <!-- Dismiss button -->
        <button
          v-if="currentStep !== STEP_DONE"
          class="text-xs text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-1 ml-auto"
          @click="dismiss"
        >
          Skip setup
          <Icon
            icon="lucide:x"
            class="w-3.5 h-3.5"
          />
        </button>
      </div>
    </div>

    <!-- ── Step content ────────────────────────────────────────────── -->
    <div class="flex-1 overflow-hidden relative">
      <Transition
        :name="transitionName"
        mode="out-in"
      >
        <div
          :key="currentStep"
          class="absolute inset-0 overflow-y-auto"
        >
          <!-- Welcome -->
          <OnboardingWelcome v-if="currentStep === STEP_WELCOME" />

          <!-- AI Provider -->
          <OnboardingProvider v-else-if="currentStep === STEP_PROVIDER" />

          <!-- Cynosure MCP -->
          <OnboardingCynosureMcp v-else-if="currentStep === STEP_CYNOSURE_MCP" />

          <!-- Memory -->
          <OnboardingMemory v-else-if="currentStep === STEP_MEMORY" />

          <!-- Memory Space -->
          <OnboardingMemorySpace v-else-if="currentStep === STEP_MEMORY_SPACE" />

          <!-- Popular MCPs -->
          <OnboardingPopularMcps v-else-if="currentStep === STEP_POPULAR_MCPS" />

          <!-- Done -->
          <div
            v-else-if="currentStep === STEP_DONE"
            class="flex flex-col items-center justify-center text-center px-4 py-12 max-w-md mx-auto h-full"
          >
            <div class="w-20 h-20 rounded-full bg-emerald-500/10 border-2 border-emerald-500/30 flex items-center justify-center mb-6">
              <Icon
                icon="lucide:check"
                class="w-10 h-10 text-emerald-400"
              />
            </div>
            <h2 class="text-2xl font-bold text-zinc-100 mb-3">
              You're all set!
            </h2>
            <p class="text-zinc-400 text-sm leading-relaxed mb-2">
              Cynosure is configured and ready to use. Start a conversation and see what your agents can do.
            </p>
            <p class="text-zinc-600 text-xs">
              You can always revisit these settings from the sidebar.
            </p>
          </div>
        </div>
      </Transition>
    </div>

    <!-- ── Footer / navigation ────────────────────────────────────── -->
    <div class="shrink-0 px-6 py-4 border-t border-zinc-800/60">
      <div class="max-w-2xl mx-auto flex items-center justify-between gap-3">
        <!-- Back -->
        <button
          v-if="currentStep > STEP_WELCOME && currentStep < STEP_DONE"
          class="flex items-center gap-1.5 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors rounded-lg hover:bg-zinc-800/60"
          @click="goBack"
        >
          <Icon
            icon="lucide:arrow-left"
            class="w-4 h-4"
          />
          Back
        </button>
        <div
          v-else
          class="w-20"
        />

        <!-- Step indicator dots (compact mobile view) -->
        <div class="flex items-center gap-1.5">
          <div
            v-for="i in totalSteps"
            :key="i"
            class="rounded-full transition-all duration-200"
            :class="currentStep === i - 1
              ? 'w-4 h-1.5 bg-blue-500'
              : currentStep > i - 1
                ? 'w-1.5 h-1.5 bg-zinc-500'
                : 'w-1.5 h-1.5 bg-zinc-700'"
          />
        </div>

        <!-- Continue / Finish / Go to Chat -->
        <div class="flex items-center gap-2">
          <!-- Required step note -->
          <span
            v-if="currentStep === STEP_PROVIDER && !canContinue"
            class="text-xs text-amber-400/80 hidden sm:block"
          >
            Add a provider first
          </span>

          <button
            v-if="currentStep < STEP_DONE"
            class="flex items-center gap-1.5 px-5 py-2 text-sm font-medium rounded-lg transition-colors"
            :class="canContinue
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'"
            :disabled="!canContinue"
            @click="goNext"
          >
            {{ currentStep === STEP_POPULAR_MCPS ? 'Finish' : 'Continue' }}
            <Icon
              icon="lucide:arrow-right"
              class="w-4 h-4"
            />
          </button>

          <button
            v-else
            class="flex items-center gap-1.5 px-5 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            @click="goToChat"
          >
            Start chatting
            <Icon
              icon="lucide:message-circle"
              class="w-4 h-4"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useOnboardingStore } from '../stores/onboarding.store'
import { useProviderStore } from '../stores/provider.store'
import OnboardingWelcome from '../components/onboarding/OnboardingWelcome.vue'
import OnboardingProvider from '../components/onboarding/OnboardingProvider.vue'
import OnboardingCynosureMcp from '../components/onboarding/OnboardingCynosureMcp.vue'
import OnboardingMemory from '../components/onboarding/OnboardingMemory.vue'
import OnboardingMemorySpace from '../components/onboarding/OnboardingMemorySpace.vue'
import OnboardingPopularMcps from '../components/onboarding/OnboardingPopularMcps.vue'

const router = useRouter()
const onboardingStore = useOnboardingStore()
const providerStore = useProviderStore()

// ── Step indices ──────────────────────────────────────────────────
const STEP_WELCOME = 0
const STEP_PROVIDER = 1
const STEP_CYNOSURE_MCP = 2
const STEP_MEMORY = 3
const STEP_MEMORY_SPACE = 4
const STEP_POPULAR_MCPS = 5
const STEP_DONE = 6

const totalSteps = STEP_DONE + 1 // 0..6

// ── Navigation state ──────────────────────────────────────────────
const currentStep = ref(STEP_WELCOME)
const direction = ref<'forward' | 'backward'>('forward')

const transitionName = computed(() =>
  direction.value === 'forward' ? 'slide-forward' : 'slide-backward'
)

// ── Breadcrumb data ───────────────────────────────────────────────
const breadcrumbSteps = [
  { id: 'provider',      label: 'AI Provider',    globalIndex: STEP_PROVIDER },
  { id: 'cynosure',      label: 'Cynosure MCP',   globalIndex: STEP_CYNOSURE_MCP },
  { id: 'memory',        label: 'Embeddings',     globalIndex: STEP_MEMORY },
  { id: 'memory-space',  label: 'Memory Space',   globalIndex: STEP_MEMORY_SPACE },
  { id: 'popular-mcps',  label: 'Popular Tools',  globalIndex: STEP_POPULAR_MCPS },
]

// Which breadcrumb index is active (0-based within breadcrumbSteps)
const breadcrumbStepIndex = computed(() =>
  Math.max(0, currentStep.value - 1) // steps 1-5 map to breadcrumb 0-4
)

const showBreadcrumb = computed(() =>
  currentStep.value >= STEP_PROVIDER && currentStep.value <= STEP_POPULAR_MCPS
)

function stepCircleClass(bIndex: number): string {
  if (breadcrumbStepIndex.value > bIndex) {
    return 'border-blue-500 bg-blue-500 text-white'
  }
  if (breadcrumbStepIndex.value === bIndex) {
    return 'border-blue-500 bg-transparent text-blue-400'
  }
  return 'border-zinc-700 bg-transparent text-zinc-600'
}

// ── Validation ────────────────────────────────────────────────────
const canContinue = computed(() => {
  if (currentStep.value === STEP_PROVIDER) {
    return providerStore.providers.length > 0
  }
  return true
})

// ── Navigation actions ─────────────────────────────────────────────
function goNext() {
  if (!canContinue.value) return
  if (currentStep.value >= STEP_DONE) return
  direction.value = 'forward'
  currentStep.value++
  if (currentStep.value === STEP_DONE) {
    onboardingStore.finish()
  }
}

function goBack() {
  if (currentStep.value <= STEP_WELCOME) return
  direction.value = 'backward'
  currentStep.value--
}

function jumpToStep(index: number) {
  if (index === currentStep.value) return
  direction.value = index > currentStep.value ? 'forward' : 'backward'
  currentStep.value = index
}

function dismiss() {
  onboardingStore.finish()
  router.push('/chat')
}

function goToChat() {
  router.push('/chat')
}
</script>

<style scoped>
/* Forward transition: enter from right, exit to left */
.slide-forward-enter-from {
  opacity: 0;
  transform: translateX(32px);
}
.slide-forward-enter-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.slide-forward-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.slide-forward-leave-to {
  opacity: 0;
  transform: translateX(-32px);
}

/* Backward transition: enter from left, exit to right */
.slide-backward-enter-from {
  opacity: 0;
  transform: translateX(-32px);
}
.slide-backward-enter-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.slide-backward-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.slide-backward-leave-to {
  opacity: 0;
  transform: translateX(32px);
}
</style>
