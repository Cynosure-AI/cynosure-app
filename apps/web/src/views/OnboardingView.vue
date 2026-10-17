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

    <!-- ── Header / progress ──────────────────────────────────────── -->
    <div class="onboarding-bar relative z-20 shrink-0 px-6 py-4 border-b border-theme-800/60">
      <div class="max-w-3xl mx-auto flex items-center gap-5">
        <div
          class="flex shrink-0 items-center gap-2"
          :class="{ invisible: currentStep === STEP_WELCOME }"
        >
          <img
            :src="logoIconUrl"
            alt=""
            class="h-7 w-7 object-contain"
          >
          <span class="hidden text-sm font-semibold tracking-tight text-theme-100 md:block">Cynosure</span>
        </div>

        <!-- Step progress (hidden on welcome/done) -->
        <nav
          v-if="showBreadcrumb"
          class="min-w-0 flex-1"
          aria-label="Setup progress"
        >
          <div class="flex items-start gap-1.5">
            <button
              v-for="(step, index) in breadcrumbSteps"
              :key="step.id"
              class="group min-w-0 flex-1 text-left disabled:cursor-not-allowed"
              :disabled="advancing || !canReachStep(step.globalIndex)"
              :aria-current="currentStep === step.globalIndex ? 'step' : undefined"
              :aria-label="`Step ${index + 1}: ${step.label}`"
              :title="canReachStep(step.globalIndex) ? step.label : 'Add a provider first'"
              @click="jumpToStep(step.globalIndex)"
            >
              <span class="block h-1 overflow-hidden rounded-full bg-theme-700/70">
                <span
                  class="progress-fill block h-full rounded-full bg-accent-500"
                  :style="{ width: breadcrumbStepIndex > index ? '100%' : breadcrumbStepIndex === index ? '50%' : '0%', ...segmentTiming(index) }"
                />
              </span>
              <span
                class="mt-2 hidden items-center gap-1 truncate text-[11px] font-medium transition-colors sm:flex"
                :class="breadcrumbStepIndex === index
                  ? 'text-theme-100'
                  : breadcrumbStepIndex > index
                    ? 'text-ink-secondary group-hover:text-theme-200'
                    : 'text-ink-faint group-enabled:group-hover:text-ink-secondary'"
              >
                <Icon
                  v-if="breadcrumbStepIndex > index"
                  icon="lucide:check"
                  class="h-3 w-3 shrink-0 text-accent-fg"
                />
                {{ step.label }}
              </span>
            </button>
          </div>
          <p class="mt-2 text-[11px] font-medium text-ink-secondary sm:hidden">
            Step {{ breadcrumbStepIndex + 1 }} of {{ breadcrumbSteps.length }} · {{ breadcrumbSteps[breadcrumbStepIndex].label }}
          </p>
        </nav>
        <div
          v-else-if="currentStep === STEP_DONE"
          class="flex flex-1 items-center gap-2 text-status-success"
        >
          <Icon
            icon="lucide:check-circle-2"
            class="w-5 h-5"
          />
          <span class="text-sm font-semibold">Setup complete</span>
        </div>
        <div
          v-else
          class="flex-1"
        />

        <!-- Dismiss button -->
        <button
          v-if="currentStep !== STEP_DONE && serverReady"
          class="shrink-0 text-xs text-ink-faint hover:text-ink-secondary transition-colors flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-60"
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
            Getting things ready
          </h2>
          <p class="text-sm text-ink-muted">
            Waiting for the Cynosure server to start…
          </p>
        </div>
      </div>
      <Transition
        v-else
        :name="transitionName"
        mode="out-in"
        @after-enter="onStepEntered"
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
            @created="createdAgentName = $event"
          />

          <!-- Done -->
          <div
            v-else-if="currentStep === STEP_DONE"
            class="flex min-h-full flex-col items-center justify-center px-4 py-10 text-center"
          >
            <div class="done-badge mb-6">
              <Icon
                icon="lucide:check"
                class="h-9 w-9"
              />
            </div>
            <h2 class="text-2xl font-semibold tracking-tight text-theme-100 sm:text-3xl">
              You're all set{{ prefs.userName.trim() ? `, ${prefs.userName.trim()}` : '' }}!
            </h2>
            <p class="mt-2 max-w-md text-sm leading-relaxed text-ink-secondary">
              Cynosure is ready. Here's what you set up — anything you skipped can be added anytime from the workspace menu.
            </p>

            <ul class="mt-7 w-full max-w-md space-y-2 text-left">
              <li
                v-for="item in summaryItems"
                :key="item.label"
                class="flex items-center gap-3 rounded-xl border px-4 py-3"
                :class="item.done ? 'border-theme-700/60 bg-theme-800/50' : 'border-theme-800 bg-theme-900/30'"
              >
                <span
                  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  :class="item.done ? 'bg-accent-500/12 text-accent-fg' : 'bg-theme-800 text-ink-faint'"
                >
                  <Icon
                    :icon="item.icon"
                    class="h-4 w-4"
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span
                    class="block text-sm font-medium"
                    :class="item.done ? 'text-theme-100' : 'text-ink-muted'"
                  >{{ item.label }}</span>
                  <span class="block truncate text-xs text-ink-faint">{{ item.detail }}</span>
                </span>
                <Icon
                  :icon="item.done ? 'lucide:circle-check' : 'lucide:circle-dashed'"
                  class="h-4 w-4 shrink-0"
                  :class="item.done ? 'text-status-success' : 'text-ink-faint'"
                />
              </li>
            </ul>

            <button
              ref="doneCtaRef"
              class="mt-8 inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold accent-action bg-accent-600 hover:bg-accent-500 text-accent-on transition-colors"
              @click="goToChat"
            >
              Start chatting
              <Icon
                icon="lucide:arrow-right"
                class="h-4 w-4"
              />
            </button>
          </div>
        </div>
      </Transition>
    </div>

    <!-- ── Footer / navigation ────────────────────────────────────── -->
    <div
      v-if="currentStep !== STEP_DONE"
      class="onboarding-bar relative z-20 shrink-0 px-6 py-4 border-t border-theme-800/60"
    >
      <div class="max-w-3xl mx-auto flex items-center justify-between gap-3">
        <!-- Back -->
        <button
          v-if="currentStep > STEP_WELCOME"
          class="flex items-center gap-1.5 px-3 py-2 text-sm text-ink-secondary hover:text-theme-200 transition-colors rounded-lg hover:bg-theme-800/60 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="advancing"
          @click="goBack"
        >
          <Icon
            icon="lucide:arrow-left"
            class="w-4 h-4"
          />
          Back
        </button>
        <span
          v-else
          class="hidden items-center gap-1.5 text-xs text-ink-faint sm:flex"
        >
          <Icon
            icon="lucide:timer"
            class="h-3.5 w-3.5"
          />
          Takes about 2 minutes
        </span>

        <div class="ml-auto flex min-w-0 items-center justify-end gap-2">
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

          <!-- Optional steps can be left without saving what they prefilled -->
          <button
            v-if="serverReady && canSkipStep"
            class="px-3 py-2 text-sm text-ink-muted hover:text-theme-200 transition-colors rounded-lg hover:bg-theme-800/60 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="advancing"
            @click="skipStep"
          >
            Skip this step
          </button>

          <button
            v-if="serverReady"
            class="flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium rounded-xl transition-colors"
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
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useOnboardingStore } from '../stores/onboarding.store'
import { useProviderStore } from '../stores/provider.store'
import { usePreferencesStore } from '../stores/preferences.store'
import { api } from '../api/client'
import { useAppBranding } from '../composables/useAppBranding'
import { useMcpServers } from '../composables/useMcpServers'
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
const { logoIconUrl } = useAppBranding()
const { servers: mcpServers, loadServers: loadMcpServers } = useMcpServers()

// ── Step indices ──────────────────────────────────────────────────
const STEP_WELCOME = 0
const STEP_PROFILE = 1
const STEP_PROVIDER = 2
const STEP_MEMORY = 3
const STEP_MCPS = 4
const STEP_AGENT = 5
const STEP_DONE = 6

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
const createdAgentName = ref('')
const memoryConfigured = ref(false)
const doneCtaRef = ref<HTMLButtonElement | null>(null)
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

// The progress fill runs segment by segment in the direction of travel,
// so moving on finishes the current segment before the next one starts.
const HALF_SEGMENT_FILL_MS = 260
/** Long jumps speed up so the whole chain stays short. */
const MAX_PROGRESS_FILL_MS = 1000
const progressFrom = ref(breadcrumbStepIndex.value)
watch(breadcrumbStepIndex, (_, previous) => { progressFrom.value = previous })

/** How full segment `index` is while step `step` is current, in half segments. */
function segmentHalves(index: number, step: number): number {
  return index < step ? 2 : index === step ? 1 : 0
}

/** Duration, delay and easing that chain segment `index` into one even fill. */
function segmentTiming(index: number): Record<string, string> {
  const from = progressFrom.value
  const to = breadcrumbStepIndex.value
  const stride = to >= from ? 1 : -1
  const halfMs = Math.min(HALF_SEGMENT_FILL_MS, MAX_PROGRESS_FILL_MS / Math.max(1, 2 * Math.abs(to - from)))
  let delay = 0
  for (let i = from; i !== to + stride; i += stride) {
    const duration = Math.abs(segmentHalves(i, to) - segmentHalves(i, from)) * halfMs
    if (i === index) {
      // Accelerate into the chain, run evenly through it, and settle at its end.
      const easing = from === to ? 'ease-out' : i === from ? 'cubic-bezier(.4, 0, 1, 1)' : i === to ? 'cubic-bezier(0, 0, .2, 1)' : 'linear'
      return { '--fill-duration': `${duration || HALF_SEGMENT_FILL_MS}ms`, '--fill-delay': `${delay}ms`, '--fill-easing': easing }
    }
    delay += duration
  }
  return {}
}

const showBreadcrumb = computed(() =>
  currentStep.value >= STEP_PROFILE && currentStep.value <= STEP_AGENT
)


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

/** Optional steps whose Continue would save or wait on something offer a way past without it. */
const canSkipStep = computed(() =>
  (currentStep.value === STEP_MEMORY && (memoryStepState.value.pending || memoryStepState.value.busy))
  || (currentStep.value === STEP_AGENT && agentDraftState.value.hasDraft)
)

const nextButtonLabel = computed(() => {
  if (advancing.value) return currentStep.value === STEP_AGENT ? 'Creating…' : 'Saving…'
  if (currentStep.value === STEP_WELCOME) return 'Get started'
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

  advance()
}

function skipStep() {
  if (advancing.value || currentStep.value >= STEP_DONE) return
  stepError.value = ''
  advance()
}

function advance() {
  direction.value = 'forward'
  currentStep.value++
  if (currentStep.value === STEP_DONE) {
    onboardingStore.finish()
    void loadSummary()
  }
}

// ── Done summary ──────────────────────────────────────────────────
async function loadSummary() {
  const [embedding] = await Promise.allSettled([api.memory.getEmbeddingConfig(), loadMcpServers()])
  memoryConfigured.value = embedding.status === 'fulfilled' && Boolean(embedding.value.providerId)
}

const summaryItems = computed(() => {
  const name = prefs.userName.trim()
  const providers = providerStore.providers
  const tools = mcpServers.value.length
  return [
    { label: 'Profile', icon: 'lucide:user-round', done: Boolean(name), detail: name ? `Cyno will call you ${name}` : 'No name set' },
    { label: 'AI provider', icon: 'lucide:plug-zap', done: providers.length > 0, detail: providers.length ? providers.map(p => p.name).join(', ') : 'Not connected yet' },
    { label: 'Memory', icon: 'lucide:brain', done: memoryConfigured.value, detail: memoryConfigured.value ? 'Embeddings configured' : 'Set up later in Settings → Memory' },
    { label: 'Tools', icon: 'lucide:blocks', done: tools > 0, detail: tools ? `${tools} MCP ${tools === 1 ? 'server' : 'servers'} installed` : 'Add tools anytime from MCP Servers' },
    { label: 'First agent', icon: 'lucide:bot', done: Boolean(createdAgentName.value), detail: createdAgentName.value || 'Create agents anytime from Agents' },
  ]
})

function onStepEntered() {
  if (currentStep.value === STEP_DONE) doneCtaRef.value?.focus()
}

/** Enter moves on from plain fields that opt in, or when nothing has focus. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target && target !== document.body && !target.hasAttribute('data-onboarding-enter')) return
  if (!serverReady.value) return
  event.preventDefault()
  if (currentStep.value === STEP_DONE) goToChat()
  else void goNext()
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
  window.addEventListener('keydown', onKeydown)
  void prefs.loadUserSettings()
  void probeServerReadiness()
  readinessPoll = setInterval(() => {
    if (!serverReady.value) void probeServerReadiness()
  }, 1200)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
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

.progress-fill {
  transition: width var(--fill-duration, 260ms) var(--fill-easing, ease-out) var(--fill-delay, 0ms);
}

.done-badge {
  display: grid;
  width: 4.5rem;
  height: 4.5rem;
  place-items: center;
  border-radius: 9999px;
  background: radial-gradient(circle at 35% 25%, color-mix(in srgb, var(--color-status-success) 30%, transparent), color-mix(in srgb, var(--color-status-success) 10%, transparent));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-status-success) 40%, transparent), 0 0 0 10px color-mix(in srgb, var(--color-status-success) 6%, transparent), 0 12px 40px -10px color-mix(in srgb, var(--color-status-success) 50%, transparent);
  color: var(--color-status-success);
  animation: done-pop 480ms cubic-bezier(.34, 1.56, .64, 1) both;
}

@keyframes done-pop {
  from { opacity: 0; transform: scale(.6); }
  to { opacity: 1; transform: scale(1); }
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

@media (prefers-reduced-motion: reduce) {
  .done-badge { animation: none; }
  .progress-fill { transition: none; }
  .slide-forward-enter-active,
  .slide-forward-leave-active,
  .slide-backward-enter-active,
  .slide-backward-leave-active { transition: opacity 0.15s ease; }
  .slide-forward-enter-from,
  .slide-forward-leave-to,
  .slide-backward-enter-from,
  .slide-backward-leave-to { transform: none; }
}
</style>
