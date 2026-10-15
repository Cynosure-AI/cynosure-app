<script setup lang="ts">
/**
 * A reactive dot lattice. Ripples expose horizontal tears, broken data columns
 * and delayed flares. At rest the wall breathes: it slowly brightens and dims
 * on a long, slightly irregular rhythm while a soft swell around a wandering
 * focus grows on the inhale and recedes on the exhale. `intensity` (0–1) scales
 * the reaction so it can sit quietly behind content. A settled field repaints
 * only the breath, from a cached lattice and at a reduced frame rate; reduced
 * motion holds one still mid-breath frame and hidden documents stop all
 * animation.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createRippleSurface, type RippleSurface } from './rippleSurface'

const props = withDefaults(defineProps<{ intensity?: number }>(), { intensity: 1 })

const canvas = ref<HTMLCanvasElement | null>(null)

const MIN_CELL = 9
const MAX_CELLS = 30000
const ALPHA_LEVELS = 16
// Only the very strongest fragments reach the paler highlight tint.
const HIGHLIGHT_LEVELS = 3
const DOT_SIZE = 1.5
// Pixels of dot shift per unit of surface slope.
const REFRACTION = 12
const MAX_PULSES = 8
const ECHO_INTERVAL_MS = 120
// Each band re-rolls its tears on its own beat so the wall never jumps in lockstep.
const GLITCH_MS = 110
// At low intensity the lattice dims less than the reaction, so it stays legible as texture.
const REST_FLOOR = 0.55
// One breath takes about this long; a slower wobble stretches and shortens it
// so the rhythm never feels metronomic.
const BREATH_MS = 8000
const BREATH_WOBBLE_MS = 29000
// The exhale dims the whole wall by this much…
const BREATH_DIM = 0.25
// …and the far field, away from the swell's focus, by up to this much more.
const BREATH_SPREAD = 0.4
// The lattice is painted this much brighter before the breath dims it, so on
// average it sits about as bright as a still wall would.
const BREATH_LIFT = 1.25
// The breath changes slowly, so a settled field repaints at this rate.
const IDLE_FRAME_MS = 1000 / 30
const STEP_MS = 1000 / 60
const MAX_STEPS_PER_FRAME = 3
// Clicks on controls belong to the control, not the water.
const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"]'

let ctx: CanvasRenderingContext2D | null = null
// The resting lattice, painted once per intensity level and reused by every breath frame.
let lattice: HTMLCanvasElement | null = null
let latticeCtx: CanvasRenderingContext2D | null = null
let latticeLevel = Number.NaN
let surface: RippleSurface | null = null
let surfaceMoving = false
let width = 0
let height = 0
let cell = MIN_CELL
// Per-dot resting brightness: speckle plus the odd brighter data column.
let restAlpha = new Float32Array(0)
let activity = new Float32Array(0)
let baseColor = ''
let highlightColor = ''
let rafId = 0
let running = false
let lastFrame = 0
let lastPaint = -Infinity
let backlog = 0
let reducedMotion = false
let resizeObserver: ResizeObserver | null = null
let motionQuery: MediaQueryList | null = null
let lastEcho = -Infinity
// Eases toward props.intensity so switching pages fades rather than snaps.
let level = props.intensity
// Starts each mount's swell somewhere different.
const breathSeed = Math.random() * Math.PI * 2

interface Pulse {
  x: number
  y: number
  start: number
  duration: number
  strength: number
  seed: number
}
let pulses: Pulse[] = []

const pointer = { x: 0, y: 0, inside: false }

function resolveColor(el: HTMLElement, token: string): string {
  const previous = el.style.color
  el.style.color = `var(${token})`
  const resolved = getComputedStyle(el).color
  el.style.color = previous
  return resolved
}

function noise(a: number, b = 0, c = 0): number {
  const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return h - Math.floor(h)
}

function seedLattice(cols: number, rows: number) {
  restAlpha = new Float32Array(cols * rows)
  for (let c = 0; c < cols; c++) {
    const column = noise(c) < 0.1 ? 0.08 : 0
    for (let r = 0; r < rows; r++) {
      restAlpha[r * cols + c] = 0.12 + 0.08 * Math.random() ** 3 + column
    }
  }
}

function addPulse(x: number, y: number, now: number) {
  if (pulses.length >= MAX_PULSES) return
  pulses.push({
    x,
    y,
    start: now + 150 + Math.random() * 250,
    duration: 950,
    // Flares follow the stroke that caused them, so they fade with intensity like the water does.
    strength: 0.7 * level * level,
    seed: Math.random() * 1000,
  })
}

function echo(x: number, y: number) {
  const now = performance.now()
  if (now - lastEcho < ECHO_INTERVAL_MS) return
  lastEcho = now
  addPulse(x + (Math.random() - 0.5) * 4, y, now)
}

function paintActivity(now: number) {
  if (!surface) return
  activity.fill(0)
  const { cols, rows } = surface
  for (const pulse of pulses) {
    const age = (now - pulse.start) / pulse.duration
    if (age < 0) continue
    const envelope = Math.sin(age * Math.PI) ** 2 * pulse.strength
    // Neighboring columns carry a packet upward with slightly different delays.
    for (let c = Math.max(0, Math.floor(pulse.x - 5)); c <= Math.min(cols - 1, pulse.x + 5); c++) {
      const column = noise(c + pulse.seed)
      const spread = Math.max(0, 1 - Math.abs(c - pulse.x) / 5)
      const head = pulse.y + 5 - age * 13 + column * 3
      for (let r = Math.max(0, Math.floor(head - 4)); r <= Math.min(rows - 1, head + 7); r++) {
        const packet = Math.max(0, 1 - Math.abs(r - head) / 4)
        const cluster = Math.max(0, 1 - Math.abs(r - pulse.y) / 7) * 0.25
        const i = r * cols + c
        activity[i] = Math.min(1, activity[i] + envelope * spread * (packet + cluster) * (0.5 + column))
      }
    }
  }
}

function bucketOf(alpha: number): number {
  return Math.min(ALPHA_LEVELS - 1, Math.floor(alpha * ALPHA_LEVELS))
}

function emptyBuckets(): Path2D[] {
  return Array.from({ length: ALPHA_LEVELS }, () => new Path2D())
}

// Batch by alpha level — one fill per level instead of one per dot.
function fillBuckets(target: CanvasRenderingContext2D, paths: Path2D[]) {
  for (let bucket = 0; bucket < ALPHA_LEVELS; bucket++) {
    target.globalAlpha = (bucket + 0.5) / ALPHA_LEVELS
    target.fillStyle = bucket >= ALPHA_LEVELS - HIGHLIGHT_LEVELS ? highlightColor : baseColor
    target.fill(paths[bucket])
  }
  target.globalAlpha = 1
}

function restScale(): number {
  return (REST_FLOOR + (1 - REST_FLOOR) * level) * BREATH_LIFT
}

/** Dims what is already painted by the current breath; only the lattice sits under it. */
function breathe(now: number) {
  if (!ctx) return
  // Reduced motion holds one still frame at mid-breath.
  const t = reducedMotion ? 0 : now
  const phase = (2 * Math.PI * t) / BREATH_MS + 0.8 * Math.sin((2 * Math.PI * t) / BREATH_WOBBLE_MS)
  const inhale = reducedMotion ? 0.5 : 0.5 - 0.5 * Math.cos(phase)
  // The focus drifts on two unrelated periods, so it wanders instead of circling.
  const x = width * (0.5 + 0.28 * Math.sin(t / 7300 + breathSeed))
  const y = height * (0.5 + 0.28 * Math.sin(t / 11900 + breathSeed * 2))
  const radius = Math.hypot(width, height) * (0.4 + 0.35 * inhale)
  const swell = ctx.createRadialGradient(x, y, 0, x, y, radius)
  swell.addColorStop(0, 'rgba(0, 0, 0, 1)')
  swell.addColorStop(1, `rgba(0, 0, 0, ${1 - BREATH_SPREAD})`)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.globalAlpha = 1 - BREATH_DIM * (1 - inhale)
  ctx.fillStyle = swell
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

function drawResting(now: number) {
  if (!ctx || !surface) return
  if (latticeLevel !== level && latticeCtx) {
    const { cols, rows } = surface
    const offset = cell / 2
    const scale = restScale()
    const paths = emptyBuckets()
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        paths[bucketOf(restAlpha[r * cols + c] * scale)].rect(c * cell + offset - DOT_SIZE / 2, r * cell + offset - DOT_SIZE / 2, DOT_SIZE, DOT_SIZE)
      }
    }
    latticeCtx.clearRect(0, 0, width, height)
    fillBuckets(latticeCtx, paths)
    latticeLevel = level
  }
  if (lattice) ctx.drawImage(lattice, 0, 0, width, height)
  breathe(now)
}

function drawDisturbed(now: number) {
  if (!ctx || !surface) return
  paintActivity(now)

  const { cols, rows, height: water, dragX, dragY } = surface
  const offset = cell / 2
  // The lattice layer breathes; the reaction is painted over it at full strength.
  const dots = emptyBuckets()
  const glows = emptyBuckets()
  const scale = restScale()
  const motion = 0.3 + 0.7 * level

  for (let r = 0; r < rows; r++) {
    // Two-row bands break into short, coherent strips rather than per-dot noise.
    const band = Math.floor(r / 2)
    const glitchFrame = Math.floor(now / GLITCH_MS + noise(band, 9))
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const left = c > 0 ? water[i - 1] : water[i]
      const right = c < cols - 1 ? water[i + 1] : water[i]
      const up = r > 0 ? water[i - cols] : water[i]
      const down = r < rows - 1 ? water[i + cols] : water[i]
      const slopeX = right - left
      const slopeY = down - up

      const drag = Math.abs(dragX[i]) + Math.abs(dragY[i])
      const energy = Math.min(1, (Math.abs(slopeX) + Math.abs(slopeY)) * 3 + Math.abs(water[i]) * 0.8 + drag * 0.35)
      const corruption = Math.min(1, energy * level + activity[i])
      const fragment = noise(band, Math.floor(c / 7), glitchFrame)
      const broken = corruption > 0.12 && fragment > 0.76
      if (broken && noise(c, r) > 0.55) continue
      // Torn strips slip by whole cells, left or right, so they stay on the lattice.
      const slip = broken ? Math.round((fragment > 0.88 ? 1 : -1) * (1 + noise(band, glitchFrame) * 3) * corruption) * cell : 0
      const column = noise(c, 3)
      const bar = corruption > 0.16 && column > 0.62
      const glow = Math.min(1, corruption * (bar ? 0.85 : 0.5))

      // Quantized displacement lets the wall lose alignment, then lock back in.
      const x = c * cell + offset + Math.round(((slopeX * REFRACTION + dragX[i] * cell) * motion) / 2) * 2 + slip - DOT_SIZE / 2
      const y = r * cell + offset + Math.round(((slopeY * REFRACTION + dragY[i] * cell) * motion) / 2) * 2 - DOT_SIZE / 2
      dots[bucketOf(restAlpha[i] * scale)].rect(x, y, DOT_SIZE, DOT_SIZE)
      if (glow < 0.02) continue
      const dotHeight = bar ? DOT_SIZE + corruption * cell * (0.5 + column) : DOT_SIZE
      glows[bucketOf(glow)].rect(x, y, DOT_SIZE, dotHeight)
    }
  }

  fillBuckets(ctx, dots)
  breathe(now)
  fillBuckets(ctx, glows)
}

function draw(now = performance.now()) {
  if (!ctx || !surface) return
  pulses = pulses.filter(pulse => now < pulse.start + pulse.duration)
  ctx.clearRect(0, 0, width, height)
  if (surfaceMoving || pulses.length > 0) drawDisturbed(now)
  else drawResting(now)
}

function tick(now: number) {
  if (!surface) return
  // The simulation runs on a fixed 60 Hz step so ripples travel at the same speed on any display.
  backlog = Math.min(backlog + now - lastFrame, STEP_MS * MAX_STEPS_PER_FRAME)
  lastFrame = now
  while (backlog >= STEP_MS) {
    if (surfaceMoving) {
      surfaceMoving = surface.step()
      // Settle exactly to rest so the breath runs over the clean lattice.
      if (!surfaceMoving) surface.reset()
    }
    level += (props.intensity - level) * 0.08
    if (Math.abs(props.intensity - level) < 0.004) level = props.intensity
    backlog -= STEP_MS
  }
  // Only the breath moves a settled field, and it needs far fewer frames.
  const settled = !surfaceMoving && pulses.length === 0 && level === props.intensity
  if (!settled || now - lastPaint >= IDLE_FRAME_MS) {
    draw(now)
    lastPaint = now
  }
  rafId = requestAnimationFrame(tick)
}

function wake() {
  if (running || reducedMotion || document.hidden || !surface) return
  running = true
  lastFrame = performance.now()
  lastPaint = -Infinity
  backlog = STEP_MS
  rafId = requestAnimationFrame(tick)
}

function resize() {
  const el = canvas.value
  if (!el || !ctx) return
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = rect.width
  height = rect.height
  el.width = Math.round(width * dpr)
  el.height = Math.round(height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  lattice ??= document.createElement('canvas')
  lattice.width = el.width
  lattice.height = el.height
  latticeCtx = lattice.getContext('2d')
  latticeCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  latticeLevel = Number.NaN
  cell = Math.max(MIN_CELL, Math.sqrt((width * height) / MAX_CELLS))
  const cols = Math.ceil(width / cell)
  const rows = Math.ceil(height / cell)
  surface = createRippleSurface(cols, rows)
  surfaceMoving = false
  pulses = []
  activity = new Float32Array(cols * rows)
  seedLattice(cols, rows)
  baseColor = resolveColor(el, '--color-accent-500')
  highlightColor = resolveColor(el, '--color-accent-300')
  pointer.inside = false
  draw()
}

function onPointerMove(event: PointerEvent) {
  const el = canvas.value
  if (!el || !surface || reducedMotion || document.hidden) return
  const rect = el.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
  const distance = Math.hypot(x - pointer.x, y - pointer.y)
  if (inside && pointer.inside && distance > 0) {
    // Stamp at most a cell apart so fast strokes leave a continuous wake.
    const stamps = Math.min(48, Math.ceil(distance / cell))
    const moveX = (x - pointer.x) / cell / stamps
    const moveY = (y - pointer.y) / cell / stamps
    for (let k = 1; k <= stamps; k++) {
      const t = k / stamps
      surface.press((pointer.x + (x - pointer.x) * t) / cell - 0.5, (pointer.y + (y - pointer.y) * t) / cell - 0.5, moveX, moveY)
    }
    surfaceMoving = true
    echo(x / cell - 0.5, y / cell - 0.5)
    wake()
  }
  // Entering starts a fresh stroke instead of dragging in from wherever the cursor left.
  pointer.x = x
  pointer.y = y
  pointer.inside = inside
}

function onPointerDown(event: PointerEvent) {
  const el = canvas.value
  if (!el || !surface || reducedMotion || document.hidden || event.button !== 0) return
  if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return
  const rect = el.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return
  surface.drop(x / cell - 0.5, y / cell - 0.5)
  surfaceMoving = true
  echo(x / cell - 0.5, y / cell - 0.5)
  wake()
}

function onPointerLeave() {
  pointer.inside = false
}

function stop() {
  cancelAnimationFrame(rafId)
  running = false
  surfaceMoving = false
  pulses = []
  lastEcho = -Infinity
  pointer.inside = false
  level = props.intensity
  surface?.reset()
}

watch(() => props.intensity, (intensity) => {
  if (reducedMotion || document.hidden) {
    level = intensity
    draw()
    return
  }
  wake()
})

function onActivityChange() {
  reducedMotion = motionQuery?.matches ?? false
  stop()
  draw()
  wake()
}

onMounted(() => {
  const el = canvas.value
  ctx = el?.getContext('2d') ?? null
  if (!el || !ctx) return

  motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  reducedMotion = motionQuery?.matches ?? false
  resize()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(el)
  }
  motionQuery?.addEventListener('change', onActivityChange)
  document.addEventListener('visibilitychange', onActivityChange)
  wake()

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  document.documentElement.addEventListener('pointerleave', onPointerLeave)
})

onBeforeUnmount(() => {
  stop()
  resizeObserver?.disconnect()
  motionQuery?.removeEventListener('change', onActivityChange)
  document.removeEventListener('visibilitychange', onActivityChange)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerdown', onPointerDown)
  document.documentElement.removeEventListener('pointerleave', onPointerLeave)
  ctx = null
  latticeCtx = null
  lattice = null
  surface = null
})
</script>

<template>
  <canvas
    ref="canvas"
    class="water-ripple-field pointer-events-none"
    aria-hidden="true"
  />
</template>

<style scoped>
.water-ripple-field {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
