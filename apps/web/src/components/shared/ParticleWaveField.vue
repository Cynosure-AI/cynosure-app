<script setup lang="ts">
/**
 * Decorative particle terrain: a perspective grid of dots riding layered sine
 * waves, tinted with the active theme's accent. The cursor acts as a magnet:
 * nearby dots are spring-pulled into a dense, gently breathing cluster around it
 * and wobble back into place when it leaves. Renders a single still frame when the user prefers
 * reduced motion.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)

const MAX_POINTS = 18000
const ALPHA_LEVELS = 8
const HORIZON = 0.15
const CAMERA_HEIGHT = 1
const NEAR = 0.7
const FAR = 4.6
const WAVE_AMPLITUDE = 0.47
// Waves flatten toward the camera so the front row never lifts off the bottom edge.
const NEAR_DAMPING = 0.35
const DAMPING_DEPTH = 1.6

const MAGNET_RADIUS = 180
// Fraction of its distance a dot at the centre is drawn in; must stay < 1 so dots never cross.
const MAGNET_CONTRACT = 0.62
const MAGNET_BREATH = 0.06
const SPRING = 0.045
const FRICTION = 0.84

let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0
let focal = 0
let count = 0
let xs = new Float32Array(0)
let zs = new Float32Array(0)
// Per-dot magnet displacement and velocity, in screen pixels.
let ox = new Float32Array(0)
let oy = new Float32Array(0)
let vx = new Float32Array(0)
let vy = new Float32Array(0)
let lastFrame = 0
let baseColor = ''
let highlightColor = ''
let rafId = 0
let startTime = 0
let reducedMotion = false
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, strength: 0, active: false }

function resolveColor(el: HTMLElement, token: string): string {
  const previous = el.style.color
  el.style.color = `var(${token})`
  const resolved = getComputedStyle(el).color
  el.style.color = previous
  return resolved
}

function resolveColors(el: HTMLElement) {
  const scheme = getComputedStyle(el).colorScheme ?? ''
  const isLight = scheme.includes('light') && !scheme.includes('dark')
  baseColor = resolveColor(el, isLight ? '--color-accent-500' : '--color-accent-400')
  highlightColor = resolveColor(el, isLight ? '--color-accent-700' : '--color-accent-100')
}

function seedPoints() {
  let cols = Math.round(width / 6)
  let rows = Math.round(height / 6.5)
  const scale = Math.min(1, Math.sqrt(MAX_POINTS / Math.max(1, cols * rows)))
  cols = Math.max(20, Math.round(cols * scale))
  rows = Math.max(12, Math.round(rows * scale))
  count = cols * rows
  xs = new Float32Array(count)
  zs = new Float32Array(count)
  ox = new Float32Array(count)
  oy = new Float32Array(count)
  vx = new Float32Array(count)
  vy = new Float32Array(count)
  let i = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Screen-space columns (with 10% overscan) so every row spans the full width.
      xs[i] = ((c + Math.random()) / cols) * 2.2 - 1.1
      // Bias rows toward the camera; perspective already packs far rows densely.
      zs[i] = NEAR + ((r + Math.random()) / rows) ** 1.8 * (FAR - NEAR)
      i++
    }
  }
}

function waveHeight(x: number, z: number, t: number): number {
  return 0.3 * Math.sin(x * 1.1 + t * 0.32) * Math.cos(z * 0.9 - t * 0.21)
    + 0.12 * Math.sin(x * 2.3 - z * 1.7 + t * 0.5)
    + 0.05 * Math.sin(x * 5.1 + z * 3.7 - t * 0.8)
}

function draw(t: number, step = 1) {
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)

  const halfW = width / 2
  const horizonY = height * HORIZON
  const radiusSq = MAGNET_RADIUS * MAGNET_RADIUS
  const magnetOn = pointer.strength > 0.001
  const friction = FRICTION ** step
  const contract = MAGNET_CONTRACT + MAGNET_BREATH * Math.sin(t * 2.1)
  const paths = Array.from({ length: ALPHA_LEVELS }, () => new Path2D())

  for (let i = 0; i < count; i++) {
    const z = zs[i]
    const worldX = (xs[i] * halfW * z) / focal
    const wave = waveHeight(worldX, z, t)
    const damping = NEAR_DAMPING + (1 - NEAR_DAMPING) * Math.min(1, (z - NEAR) / DAMPING_DEPTH)
    const baseX = halfW + xs[i] * halfW
    const baseY = horizonY + ((CAMERA_HEIGHT - wave * damping) * focal) / z

    const crest = Math.min(1, Math.max(0, (wave + WAVE_AMPLITUDE) / (2 * WAVE_AMPLITUDE)))
    const depth = (z - NEAR) / (FAR - NEAR)
    let alpha = (0.16 + 0.84 * crest ** 1.6) * (1 - 0.5 * depth * depth)

    // Spring each dot toward a target offset: zero at rest, or its spot in the magnet's pull.
    let targetX = 0
    let targetY = 0
    let inField = false
    if (magnetOn) {
      const dx = baseX - pointer.x
      const dy = baseY - pointer.y
      const distSq = dx * dx + dy * dy
      if (distSq < radiusSq) {
        inField = true
        const s = 1 - Math.sqrt(distSq) / MAGNET_RADIUS
        const influence = s * s * (3 - 2 * s) * pointer.strength
        // Radial squeeze that keeps dots in order: denser toward the cursor, no hole.
        targetX = -dx * contract * influence
        targetY = -dy * contract * influence
        alpha += influence * 0.8
      }
    }
    const ax = SPRING * (targetX - ox[i])
    const ay = SPRING * (targetY - oy[i])

    if (inField || ox[i] !== 0 || oy[i] !== 0 || vx[i] !== 0 || vy[i] !== 0) {
      vx[i] = (vx[i] + ax * step) * friction
      vy[i] = (vy[i] + ay * step) * friction
      ox[i] += vx[i] * step
      oy[i] += vy[i] * step
      // Moving dots glint; settled ones snap to rest to skip work next frame.
      const speed = Math.abs(vx[i]) + Math.abs(vy[i])
      alpha += Math.min(0.5, speed * 0.08)
      if (!inField && speed < 0.01 && Math.abs(ox[i]) + Math.abs(oy[i]) < 0.05) {
        ox[i] = oy[i] = vx[i] = vy[i] = 0
      }
    }

    const sx = baseX + ox[i]
    const sy = baseY + oy[i]
    alpha = Math.min(1, alpha)
    if (alpha < 0.04 || sy < -4 || sy > height + 4) continue
    const size = Math.min(2.4, Math.max(0.9, 1.5 / z + 0.6))
    const level = Math.min(ALPHA_LEVELS - 1, Math.floor(alpha * ALPHA_LEVELS))
    paths[level].rect(sx - size / 2, sy - size / 2, size, size)
  }

  // Batch by alpha level — one fill per level instead of one per dot.
  for (let level = 0; level < ALPHA_LEVELS; level++) {
    ctx.globalAlpha = (level + 0.5) / ALPHA_LEVELS
    ctx.fillStyle = level === ALPHA_LEVELS - 1 ? highlightColor : baseColor
    ctx.fill(paths[level])
  }
  ctx.globalAlpha = 1
}

function tick(now: number) {
  // Physics is tuned per 60 Hz frame; scale so high-refresh displays feel the same.
  const step = Math.min(2, Math.max(0.25, ((now - lastFrame) / 1000) * 60))
  lastFrame = now
  pointer.x += (pointer.targetX - pointer.x) * 0.25 * step
  pointer.y += (pointer.targetY - pointer.y) * 0.25 * step
  pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * 0.08 * step
  draw((now - startTime) / 1000, step)
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
  focal = height * 0.75
  el.width = Math.round(width * dpr)
  el.height = Math.round(height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  resolveColors(el)
  seedPoints()
  if (reducedMotion) draw(0)
}

function onThemeChange() {
  const el = canvas.value
  if (!el) return
  resolveColors(el)
  if (reducedMotion) draw(0)
}

function onPointerMove(event: PointerEvent) {
  const el = canvas.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
  if (inside && !pointer.active && pointer.strength < 0.01) {
    // Enter without sweeping in from the previous position.
    pointer.x = x
    pointer.y = y
  }
  pointer.targetX = x
  pointer.targetY = y
  pointer.active = inside
}

function onPointerLeave() {
  pointer.active = false
}

onMounted(() => {
  const el = canvas.value
  ctx = el?.getContext('2d') ?? null
  if (!el || !ctx) return

  reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  resize()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(el)
  }
  themeObserver = new MutationObserver(onThemeChange)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  if (reducedMotion) return

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onPointerLeave)
  startTime = performance.now()
  lastFrame = startTime
  rafId = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  window.removeEventListener('pointermove', onPointerMove)
  document.documentElement.removeEventListener('pointerleave', onPointerLeave)
  ctx = null
})
</script>

<template>
  <canvas
    ref="canvas"
    class="particle-wave-field pointer-events-none"
    aria-hidden="true"
  />
</template>

<style scoped>
.particle-wave-field {
  display: block;
  width: 100%;
  height: 100%;
  /* Soften the field behind centered content so text stays readable. */
  mask-image: radial-gradient(ellipse 45% 35% at 50% 50%, rgb(0 0 0 / 0.35), #000);
}
</style>
