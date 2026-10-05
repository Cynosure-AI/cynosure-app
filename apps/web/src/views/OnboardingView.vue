<template>
  <div class="onboarding-shell h-full flex flex-col overflow-hidden">
    <div
      class="onboarding-orbit onboarding-orbit--top"
      aria-hidden="true"
    />
    <div
      class="onboarding-orbit onboarding-orbit--bottom"
      aria-hidden="true"
    />
    <div
      class="onboarding-dots onboarding-dots--top"
      aria-hidden="true"
    />
    <div
      class="onboarding-dots onboarding-dots--bottom"
      aria-hidden="true"
    />

    <!-- ── Header / breadcrumb ─────────────────────────────────────── -->
    <div class="onboarding-bar relative z-20 shrink-0 px-6 pt-5 pb-4 border-b border-theme-800/60">
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
              :class="breadcrumbStepIndex > index - 1 ? 'bg-accent-500' : 'bg-theme-700'"
            />
            <!-- Step circle -->
            <button
              class="flex flex-col items-center gap-1 group disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="advancing || !canReachStep(step.globalIndex)"
              :aria-current="currentStep === step.globalIndex ? 'step' : undefined"
              :title="canReachStep(step.globalIndex) ? undefined : 'Add a provider first'"
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
                :class="breadcrumbStepIndex === index ? 'text-theme-200' : breadcrumbStepIndex > index ? 'text-ink-secondary' : 'text-ink-faint'"
              >{{ step.label }}</span>
            </button>
          </template>
        </div>
        <div
          v-else-if="currentStep === STEP_DONE"
          class="flex items-center gap-2 text-status-success"
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
          v-if="currentStep !== STEP_DONE && serverReady"
          class="text-xs text-ink-faint hover:text-ink-secondary transition-colors flex items-center gap-1 ml-auto disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="advancing"
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
    <div class="relative z-10 flex-1 overflow-hidden">
      <div
        v-if="!serverReady"
        class="absolute inset-0 flex items-center justify-center px-6"
      >
        <div class="text-center max-w-sm">
          <div class="w-14 h-14 rounded-full border border-theme-700 bg-theme-900/60 flex items-center justify-center mx-auto mb-4">
            <Icon
              icon="lucide:loader-2"
              class="w-7 h-7 text-accent-fg animate-spin"
            />
          </div>
          <h2 class="text-lg font-semibold text-theme-100 mb-1">
            Initializing
          </h2>
          <p class="text-sm text-ink-muted">
            Waiting for server readiness before starting onboarding.
          </p>
        </div>
      </div>
      <Transition
        v-else
        :name="transitionName"
        mode="out-in"
      >
        <div
          :key="currentStep"
          class="absolute inset-0 overflow-y-auto"
        >
          <!-- Welcome -->
          <OnboardingWelcome v-if="currentStep === STEP_WELCOME" />

          <!-- Profile -->
          <OnboardingProfile v-else-if="currentStep === STEP_PROFILE" />

          <!-- AI Provider -->
          <OnboardingProvider v-else-if="currentStep === STEP_PROVIDER" />

          <!-- Memory -->
          <OnboardingMemory
            v-else-if="currentStep === STEP_MEMORY"
            ref="memoryStepRef"
            @state-change="memoryStepState = $event"
          />

          <!-- MCP tools -->
          <OnboardingPopularMcps v-else-if="currentStep === STEP_MCPS" />

          <!-- First agent -->
          <OnboardingAgent
            v-else-if="currentStep === STEP_AGENT"
            ref="agentStepRef"
            @draft-change="agentDraftState = $event"
          />

          <!-- Done -->
          <div
            v-else-if="currentStep === STEP_DONE"
            class="flex flex-col items-center justify-center text-center px-4 py-12 max-w-md mx-auto h-full"
          >
            <div class="w-20 h-20 rounded-full bg-emerald-500/10 border-2 border-emerald-500/30 flex items-center justify-center mb-6">
              <Icon
                icon="lucide:check"
                class="w-10 h-10 text-status-success"
              />
            </div>
            <h2 class="text-2xl font-bold text-theme-100 mb-3">
              You're all set!
            </h2>
            <p class="text-ink-secondary text-sm leading-relaxed mb-2">
              Cynosure is configured and ready to use. Start a conversation and see what your agents can do.
            </p>
            <p class="text-ink-faint text-xs">
              You can always revisit these settings from the workspace drawer.
            </p>
          </div>
        </div>
      </Transition>
    </div>

    <!-- ── Footer / navigation ────────────────────────────────────── -->
    <div class="onboarding-bar relative z-20 shrink-0 px-6 py-4 border-t border-theme-800/60">
      <div class="max-w-2xl mx-auto flex items-center justify-between gap-3">
        <!-- Back -->
        <button
          v-if="currentStep > STEP_WELCOME && currentStep < STEP_DONE"
          class="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-secondary hover:text-theme-200 transition-colors rounded-lg hover:bg-theme-800/60 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="advancing"
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
              ? 'w-4 h-1.5 bg-accent-500'
              : currentStep > i - 1
                ? 'w-1.5 h-1.5 bg-theme-500'
                : 'w-1.5 h-1.5 bg-theme-700'"
          />
        </div>

        <!-- Continue / Finish / Go to Chat -->
        <div class="flex items-center gap-2">
          <span
            v-if="!serverReady"
            class="text-xs text-ink-muted"
          >
            Connecting to server...
          </span>

          <!-- Required step note -->
          <span
            v-if="serverReady && currentStep === STEP_PROVIDER && !canContinue"
            class="text-xs text-status-warning/80 hidden sm:block"
          >
            Add a provider first
          </span>

          <span
            v-if="stepError"
            class="max-w-xs text-right text-xs text-status-danger"
            role="alert"
          >
            {{ stepError }}
          </span>

          <span
            v-if="serverReady && currentStep === STEP_AGENT && agentDraftState.hasDraft && !agentDraftState.valid"
            class="text-xs text-status-warning/80 hidden sm:block"
          >
            Add an agent name
          </span>

          <button
            v-if="serverReady && currentStep < STEP_DONE"
            class="flex items-center gap-1.5 px-5 py-2 text-sm font-medium rounded-lg transition-colors"
            :class="canContinue
              ? 'accent-action bg-accent-600 hover:bg-accent-500 text-accent-on'
              : 'bg-theme-800 text-ink-muted cursor-not-allowed'"
            :disabled="!canContinue || advancing"
            @click="goNext"
          >
            <Icon
              v-if="advancing"
              icon="lucide:loader-2"
              class="w-4 h-4 animate-spin"
            />
            {{ nextButtonLabel }}
            <Icon
              v-if="!advancing"
              icon="lucide:arrow-right"
              class="w-4 h-4"
            />
          </button>

          <button
            v-else-if="serverReady"
            class="flex items-center gap-1.5 px-5 py-2 text-sm font-medium accent-action bg-accent-600 hover:bg-accent-500 text-accent-on rounded-lg transition-colors"
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
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useOnboardingStore } from '../stores/onboarding.store'
import { useProviderStore } from '../stores/provider.store'
import { usePreferencesStore } from '../stores/preferences.store'
import { api } from '../api/client'
import OnboardingWelcome from '../components/onboarding/OnboardingWelcome.vue'
import OnboardingProfile from '../components/onboarding/OnboardingProfile.vue'
import OnboardingProvider from '../components/onboarding/OnboardingProvider.vue'
import OnboardingMemory from '../components/onboarding/OnboardingMemory.vue'
import OnboardingPopularMcps from '../components/onboarding/OnboardingPopularMcps.vue'
import OnboardingAgent from '../components/onboarding/OnboardingAgent.vue'

interface OnboardingAgentHandle {
  createAgent: () => Promise<boolean>
}

interface OnboardingMemoryHandle {
  save: () => Promise<boolean>
}

const router = useRouter()
const onboardingStore = useOnboardingStore()
const providerStore = useProviderStore()
const prefs = usePreferencesStore()

// ── Step indices ──────────────────────────────────────────────────
const STEP_WELCOME = 0
const STEP_PROFILE = 1
const STEP_PROVIDER = 2
const STEP_MEMORY = 3
const STEP_MCPS = 4
const STEP_AGENT = 5
const STEP_DONE = 6

const totalSteps = STEP_DONE + 1 // 0..6

// ── Navigation state ──────────────────────────────────────────────
const currentStep = ref(STEP_WELCOME)
const direction = ref<'forward' | 'backward'>('forward')
const serverReady = ref(false)
const advancing = ref(false)
const agentStepRef = ref<OnboardingAgentHandle | null>(null)
const agentDraftState = ref({ hasDraft: false, valid: true })
const memoryStepRef = ref<OnboardingMemoryHandle | null>(null)
const memoryStepState = ref({ pending: false, busy: false })
/** Why the last attempt to leave the current step failed. */
const stepError = ref('')
let readinessPoll: ReturnType<typeof setInterval> | null = null

const transitionName = computed(() =>
  direction.value === 'forward' ? 'slide-forward' : 'slide-backward'
)

// ── Breadcrumb data ───────────────────────────────────────────────
const breadcrumbSteps = [
  { id: 'profile', label: 'Profile', globalIndex: STEP_PROFILE },
  { id: 'provider', label: 'AI Provider', globalIndex: STEP_PROVIDER },
  { id: 'memory', label: 'Memory', globalIndex: STEP_MEMORY },
  { id: 'mcps', label: 'MCP Tools', globalIndex: STEP_MCPS },
  { id: 'agent', label: 'First Agent', globalIndex: STEP_AGENT },
]

// Which breadcrumb index is active (0-based within breadcrumbSteps)
const breadcrumbStepIndex = computed(() =>
  Math.max(0, currentStep.value - 1) // steps 1-5 map to breadcrumb 0-4
)

const showBreadcrumb = computed(() =>
  currentStep.value >= STEP_PROFILE && currentStep.value <= STEP_AGENT
)

function stepCircleClass(bIndex: number): string {
  if (breadcrumbStepIndex.value > bIndex) {
    return 'border-accent-500 accent-action bg-accent-500 text-accent-on'
  }
  if (breadcrumbStepIndex.value === bIndex) {
    return 'border-accent-500 bg-transparent text-accent-fg'
  }
  return 'border-theme-700 bg-transparent text-ink-faint'
}

// ── Validation ────────────────────────────────────────────────────
const canContinue = computed(() => {
  if (currentStep.value === STEP_PROVIDER) {
    return providerStore.providers.length > 0
  }
  if (currentStep.value === STEP_MEMORY) {
    return !memoryStepState.value.busy
  }
  if (currentStep.value === STEP_AGENT) {
    return agentDraftState.value.valid
  }
  return true
})

const nextButtonLabel = computed(() => {
  if (advancing.value) return currentStep.value === STEP_AGENT ? 'Creating…' : 'Saving…'
  if (currentStep.value === STEP_MEMORY && memoryStepState.value.pending) return 'Save & continue'
  if (currentStep.value === STEP_AGENT) {
    return agentDraftState.value.hasDraft ? 'Create agent' : 'Skip for now'
  }
  return 'Continue'
})

// ── Navigation actions ─────────────────────────────────────────────
/** Persist the current step's input before leaving it. Returns false to stay. */
async function saveCurrentStep(): Promise<boolean> {
  stepError.value = ''
  if (currentStep.value === STEP_PROFILE) {
    advancing.value = true
    try {
      await prefs.saveUserName()
    } catch (error) {
      stepError.value = `Your name could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`
      return false
    } finally {
      advancing.value = false
    }
  }
  if (currentStep.value === STEP_MEMORY && memoryStepState.value.pending) {
    advancing.value = true
    try {
      // The step shows its own error message.
      return await memoryStepRef.value?.save() ?? true
    } finally {
      advancing.value = false
    }
  }
  return true
}

async function goNext() {
  if (!canContinue.value || advancing.value) return
  if (currentStep.value >= STEP_DONE) return

  if (!await saveCurrentStep()) return

  if (currentStep.value === STEP_AGENT && agentDraftState.value.hasDraft) {
    advancing.value = true
    const created = await agentStepRef.value?.createAgent()
    advancing.value = false
    if (!created) return
  }

  direction.value = 'forward'
  currentStep.value++
  if (currentStep.value === STEP_DONE) {
    onboardingStore.finish()
  }
}

function goBack() {
  if (advancing.value || currentStep.value <= STEP_WELCOME) return
  stepError.value = ''
  direction.value = 'backward'
  currentStep.value--
}

/** Steps after the provider step need a provider, whichever way the user gets there. */
function canReachStep(index: number): boolean {
  return index <= STEP_PROVIDER || providerStore.providers.length > 0
}

async function jumpToStep(index: number) {
  if (advancing.value || index === currentStep.value || !canReachStep(index)) return
  // Moving forward saves like Continue; going back to review keeps unsaved input only on this step.
  if (index > currentStep.value && !await saveCurrentStep()) return
  if (index < currentStep.value && currentStep.value === STEP_PROFILE && !await saveCurrentStep()) return

  direction.value = index > currentStep.value ? 'forward' : 'backward'
  currentStep.value = index
}

async function dismiss() {
  if (advancing.value) return
  if (currentStep.value === STEP_PROFILE) {
    try {
      await prefs.saveUserName()
    } catch { /* Skipping setup should remain available if profile persistence fails. */ }
  }
  onboardingStore.finish()
  router.push('/chat')
}

function goToChat() {
  router.push('/chat')
}

async function probeServerReadiness() {
  try {
    const res = await api.system.health()
    if (res?.status === 'ok') {
      serverReady.value = true
      if (readinessPoll) {
        clearInterval(readinessPoll)
        readinessPoll = null
      }
    }
  } catch {
    serverReady.value = false
  }
}

onMounted(() => {
  void prefs.loadUserSettings()
  void probeServerReadiness()
  readinessPoll = setInterval(() => {
    if (!serverReady.value) void probeServerReadiness()
  }, 1200)
})

onUnmounted(() => {
  if (readinessPoll) clearInterval(readinessPoll)
})
</script>

<style scoped>
.onboarding-shell {
  position: relative;
  isolation: isolate;
  background:
    radial-gradient(circle at 4% 3%, color-mix(in srgb, var(--color-accent-600) 14%, transparent), transparent 25rem),
    radial-gradient(circle at 97% 96%, color-mix(in srgb, var(--color-accent-600) 13%, transparent), transparent 28rem),
    linear-gradient(145deg, color-mix(in srgb, var(--color-theme-900) 90%, transparent), color-mix(in srgb, var(--color-theme-950) 97%, transparent));
}

.onboarding-shell::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image: repeating-linear-gradient(135deg, transparent 0 10px, color-mix(in srgb, var(--color-theme-100) 2%, transparent) 10px 11px);
  mask-image: linear-gradient(to bottom, transparent 22%, #000 100%);
  pointer-events: none;
  content: '';
}

.onboarding-bar {
  background: color-mix(in srgb, var(--color-theme-950) 68%, transparent);
  backdrop-filter: blur(14px);
}

.onboarding-orbit {
  position: absolute;
  z-index: 0;
  width: 28rem;
  height: 28rem;
  border: 1px solid color-mix(in srgb, var(--color-accent-500) 34%, transparent);
  border-radius: 9999px;
  pointer-events: none;
}

.onboarding-orbit::after {
  position: absolute;
  inset: 6rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-300) 12%, transparent);
  border-radius: inherit;
  content: '';
}

.onboarding-orbit--top {
  top: -19rem;
  left: -10rem;
}

.onboarding-orbit--bottom {
  right: -11rem;
  bottom: -20rem;
}

.onboarding-dots {
  position: absolute;
  z-index: 0;
  width: 10rem;
  height: 6rem;
  opacity: .45;
  background-image: radial-gradient(circle, var(--color-accent-400) 1px, transparent 1.5px);
  background-size: 18px 18px;
  pointer-events: none;
}

.onboarding-dots--top {
  top: 5.5rem;
  right: 3rem;
  mask-image: linear-gradient(135deg, transparent, #000);
}

.onboarding-dots--bottom {
  bottom: 5.5rem;
  left: 3rem;
  mask-image: linear-gradient(315deg, transparent, #000);
}

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

@media (max-width: 639px) {
  .onboarding-orbit {
    width: 21rem;
    height: 21rem;
    opacity: .6;
  }

  .onboarding-orbit::after {
    inset: 4.5rem;
  }

  .onboarding-orbit--top {
    top: -14rem;
    left: -9rem;
  }

  .onboarding-orbit--bottom {
    right: -10rem;
    bottom: -15rem;
  }

  .onboarding-dots {
    opacity: .32;
  }

  .onboarding-dots--top {
    top: 4.5rem;
    right: -2rem;
  }

  .onboarding-dots--bottom {
    bottom: 4.5rem;
    left: -2rem;
  }
}
</style>
