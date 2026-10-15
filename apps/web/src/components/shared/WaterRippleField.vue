<script setup lang="ts">
/**
 * A reactive Blackwall lattice. Ripples expose horizontal tears, broken data
 * columns and delayed flares, while sparse idle pulses suggest activity behind
 * the wall. `intensity` (0–1) scales the whole effect so it can sit quietly
 * behind content; ambient pulses only run near full strength. The canvas sleeps
 * between disturbances and stays still for reduced motion; hidden documents stop
 * all animation and ambient timers.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createRippleSurface, type RippleSurface } from './rippleSurface'

const props = withDefaults(defineProps<{ intensity?: number }>(), { intensity: 1 })

const canvas = ref<HTMLCanvasElement | null>(null)

const MIN_CELL = 9
const MAX_CELLS = 30000
const ALPHA_LEVELS = 16
// Only the very strongest fragments reach the paler highlight tint.
const HIGHLIGHT_LEVELS = 2
const DOT_SIZE = 1.5
// Pixels of dot shift per unit of surface slope.
const REFRACTION = 12
const MAX_PULSES = 8
const ECHO_INTERVAL_MS = 120
// Each band re-rolls its tears on its own beat so the wall never jumps in lockstep.
const GLITCH_MS = 110
// At low intensity the lattice dims less than the reaction, so it stays legible as texture.
const REST_FLOOR = 0.55
const AMBIENT_LEVEL = 0.3
// Idle pulses ignore intensity so they stay visible at the quiet levels the field
// normally runs at; AMBIENT_LEVEL alone decides whether they run.
const AMBIENT_STRENGTH = 0.45
const STEP_MS = 1000 / 60
const MAX_STEPS_PER_FRAME = 3
// Clicks on controls belong to the control, not the water.
const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"]'

let ctx: CanvasRenderingContext2D | null = null
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
let backlog = 0
let reducedMotion = false
let resizeObserver: ResizeObserver | null = null
let motionQuery: MediaQueryList | null = null
let ambientTimer: ReturnType<typeof setTimeout> | null = null
let lastEcho = -Infinity
// Eases toward props.intensity so switching pages fades rather than snaps.
let level = props.intensity

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

function addPulse(x: number, y: number, now: number, ambient = false) {
  if (pulses.length >= MAX_PULSES) return
  pulses.push({
    x,
    y,
    start: now + (ambient ? 0 : 150 + Math.random() * 250),
    duration: ambient ? 2000 : 950,
    // Flares follow the stroke that caused them, so they fade with intensity like the water does.
    strength: ambient ? AMBIENT_STRENGTH : 0.7 * level * level,
    seed: Math.random() * 1000,
  })
}

function echo(x: number, y: number) {
  const now = performance.now()
  if (now - lastEcho < ECHO_INTERVAL_MS) return
  lastEcho = now
  addPulse(x + (Math.random() - 0.5) * 4, y, now)
}

function scheduleAmbient() {
  if (ambientTimer !== null || reducedMotion || document.hidden || !surface || props.intensity < AMBIENT_LEVEL) return
  ambientTimer = setTimeout(() => {
    ambientTimer = null
    if (!surface) return
    addPulse(Math.random() * (surface.cols - 1), Math.random() * (surface.rows - 1), performance.now(), true)
    wake()
    scheduleAmbient()
  }, 3200 + Math.random() * 2800)
}

function paintActivity(now: number) {
  if (!surface) return
  activity.fill(0)
  pulses = pulses.filter(pulse => now < pulse.start + pulse.duration)
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

function draw(now = performance.now()) {
  if (!ctx || !surface) return
  ctx.clearRect(0, 0, width, height)
  paintActivity(now)

  const { cols, rows, height: water, dragX, dragY } = surface
  const offset = cell / 2
  const paths = Array.from({ length: ALPHA_LEVELS }, () => new Path2D())
  const restScale = REST_FLOOR + (1 - REST_FLOOR) * level
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
      const alpha = Math.min(1, restAlpha[i] * restScale + corruption * (bar ? 0.85 : 0.5))
      if (alpha < 0.02) continue

      // Quantized displacement lets the wall lose alignment, then lock back in.
      const x = c * cell + offset + Math.round(((slopeX * REFRACTION + dragX[i] * cell) * motion) / 2) * 2 + slip
      const y = r * cell + offset + Math.round(((slopeY * REFRACTION + dragY[i] * cell) * motion) / 2) * 2
      const bucket = Math.min(ALPHA_LEVELS - 1, Math.floor(alpha * ALPHA_LEVELS))
      const dotHeight = bar ? DOT_SIZE + corruption * cell * (0.5 + column) : DOT_SIZE
      paths[bucket].rect(x - DOT_SIZE / 2, y - DOT_SIZE / 2, DOT_SIZE, dotHeight)
    }
  }

  // Batch by alpha level — one fill per level instead of one per dot.
  for (let bucket = 0; bucket < ALPHA_LEVELS; bucket++) {
    ctx.globalAlpha = (bucket + 0.5) / ALPHA_LEVELS
    ctx.fillStyle = bucket >= ALPHA_LEVELS - HIGHLIGHT_LEVELS ? highlightColor : baseColor
    ctx.fill(paths[bucket])
  }
  ctx.globalAlpha = 1
}

function tick(now: number) {
  if (!surface) return
  // The simulation runs on a fixed 60 Hz step so ripples travel at the same speed on any display.
  backlog = Math.min(backlog + now - lastFrame, STEP_MS * MAX_STEPS_PER_FRAME)
  lastFrame = now
  while (backlog >= STEP_MS) {
    if (surfaceMoving) {
      surfaceMoving = surface.step()
      if (!surfaceMoving) surface.reset()
    }
    level += (props.intensity - level) * 0.08
    if (Math.abs(props.intensity - level) < 0.004) level = props.intensity
    backlog -= STEP_MS
  }
  if (!surfaceMoving && pulses.length === 0 && level === props.intensity) {
    // Settle exactly to rest so the parked frame is the clean lattice.
    surface.reset()
    running = false
    draw()
    return
  }
  draw(now)
  rafId = requestAnimationFrame(tick)
}

function wake() {
  if (running || reducedMotion || document.hidden || !surface) return
  running = true
  lastFrame = performance.now()
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
  if (ambientTimer !== null) clearTimeout(ambientTimer)
  ambientTimer = null
  pulses = []
  lastEcho = -Infinity
  pointer.inside = false
  level = props.intensity
  surface?.reset()
}

watch(() => props.intensity, (intensity) => {
  if (intensity < AMBIENT_LEVEL && ambientTimer !== null) {
    clearTimeout(ambientTimer)
    ambientTimer = null
  }
  scheduleAmbient()
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
  scheduleAmbient()
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
  scheduleAmbient()

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
