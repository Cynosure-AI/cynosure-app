/**
 * Damped height-field water on a grid of cells. Pressing the surface sends out
 * ripples; dragging across it also pushes a displacement field along the stroke
 * that relaxes back to rest, like a fingertip trailing through water. A drop is
 * a single harder tap that rings outward.
 * All coordinates are in cell units.
 */

// c² in cells² per step; the explicit scheme stays stable below 0.5.
const WAVE_SPEED = 0.3
const WAVE_DAMPING = 0.975
// Bleeds off any net lift so the surface always returns to flat.
const HEIGHT_DECAY = 0.985
const DRAG_DECAY = 0.93
const MAX_DRAG = 0.8
const PRESS_RADIUS = 1.6
// Per cell of travel, so a stroke disturbs the same amount at any speed.
const PRESS_DEPTH = 0.06
const DRAG_PUSH = 0.2
const DROP_RADIUS = 2.2
const DROP_DEPTH = 0.5
// Below these the surface is indistinguishable from rest.
const REST_VELOCITY = 0.004
const REST_HEIGHT = 0.01
const REST_DRAG = 0.02

export interface RippleSurface {
  readonly cols: number
  readonly rows: number
  readonly height: Float32Array
  readonly dragX: Float32Array
  readonly dragY: Float32Array
  /** Touches the surface at (x, y) while moving by (moveX, moveY); keep each move within about a cell. */
  press: (x: number, y: number, moveX: number, moveY: number) => void
  /** Taps the surface once at (x, y), sending out a ring of ripples. */
  drop: (x: number, y: number) => void
  /** Advances one fixed step and reports whether the surface is still moving. */
  step: () => boolean
  reset: () => void
}

export function createRippleSurface(cols: number, rows: number): RippleSurface {
  const count = cols * rows
  const height = new Float32Array(count)
  const velocity = new Float32Array(count)
  const dragX = new Float32Array(count)
  const dragY = new Float32Array(count)
  function stamp(x: number, y: number, radius: number, depth: number, pushX: number, pushY: number) {
    const reach = Math.ceil(radius * 2)
    const radiusSq = radius * radius
    const cx = Math.round(x)
    const cy = Math.round(y)
    for (let gy = Math.max(1, cy - reach); gy <= Math.min(rows - 2, cy + reach); gy++) {
      for (let gx = Math.max(1, cx - reach); gx <= Math.min(cols - 2, cx + reach); gx++) {
        const dx = gx - x
        const dy = gy - y
        const weight = Math.exp(-(dx * dx + dy * dy) / radiusSq)
        if (weight < 0.02) continue
        const i = gy * cols + gx
        velocity[i] -= depth * weight
        if (pushX === 0 && pushY === 0) continue
        const pushedX = dragX[i] + pushX * weight
        const pushedY = dragY[i] + pushY * weight
        const length = Math.hypot(pushedX, pushedY)
        const scale = length > MAX_DRAG ? MAX_DRAG / length : 1
        dragX[i] = pushedX * scale
        dragY[i] = pushedY * scale
      }
    }
  }

  function press(x: number, y: number, moveX: number, moveY: number) {
    stamp(x, y, PRESS_RADIUS, PRESS_DEPTH * Math.hypot(moveX, moveY), moveX * DRAG_PUSH, moveY * DRAG_PUSH)
  }

  function drop(x: number, y: number) {
    stamp(x, y, DROP_RADIUS, DROP_DEPTH, 0, 0)
  }

  function step(): boolean {
    let maxVelocity = 0
    let maxHeight = 0
    let maxDrag = 0
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x
        const laplacian = height[i - 1] + height[i + 1] + height[i - cols] + height[i + cols] - 4 * height[i]
        velocity[i] = (velocity[i] + WAVE_SPEED * laplacian) * WAVE_DAMPING
      }
    }
    for (let i = 0; i < count; i++) {
      height[i] = (height[i] + velocity[i]) * HEIGHT_DECAY
      dragX[i] *= DRAG_DECAY
      dragY[i] *= DRAG_DECAY
      maxVelocity = Math.max(maxVelocity, Math.abs(velocity[i]))
      maxHeight = Math.max(maxHeight, Math.abs(height[i]))
      maxDrag = Math.max(maxDrag, Math.abs(dragX[i]) + Math.abs(dragY[i]))
    }
    return maxVelocity > REST_VELOCITY || maxHeight > REST_HEIGHT || maxDrag > REST_DRAG
  }

  function reset() {
    height.fill(0)
    velocity.fill(0)
    dragX.fill(0)
    dragY.fill(0)
  }

  return { cols, rows, height, dragX, dragY, press, drop, step, reset }
}
