import { describe, expect, test } from 'vitest'
import { createRippleSurface } from './rippleSurface'

function strokeAcross(cols: number, rows: number) {
  const surface = createRippleSurface(cols, rows)
  for (let x = 4; x < cols - 4; x += 0.5) surface.press(x, rows / 2, 0.5, 0)
  return surface
}

describe('createRippleSurface', () => {
  test('stays at rest until touched', () => {
    const surface = createRippleSurface(20, 20)
    expect(surface.step()).toBe(false)
    expect(surface.height.every(value => value === 0)).toBe(true)
  })

  test('a stroke dips the surface and drags it along the stroke direction', () => {
    const surface = strokeAcross(40, 20)
    expect(surface.step()).toBe(true)

    const i = 10 * 40 + 20
    expect(surface.height[i]).toBeLessThan(0)
    expect(surface.dragX[i]).toBeGreaterThan(0)
    expect(Math.abs(surface.dragY[i])).toBeLessThan(1e-6)
  })

  test('settles back to rest within a few seconds of 60 Hz steps', () => {
    const surface = strokeAcross(60, 40)
    let steps = 0
    while (surface.step() && steps < 600) steps++

    expect(steps).toBeLessThan(300)
    for (const value of surface.height) expect(Math.abs(value)).toBeLessThan(0.05)
  })

  test('a drop rings outward from where it lands', () => {
    const surface = createRippleSurface(40, 40)
    surface.drop(20, 20)
    for (let i = 0; i < 12; i++) surface.step()

    const centre = Math.abs(surface.height[20 * 40 + 20])
    const ring = Math.max(...Array.from({ length: 10 }, (_, k) => Math.abs(surface.height[20 * 40 + 24 + k])))
    expect(ring).toBeGreaterThan(centre)
    expect(Math.abs(surface.dragX[20 * 40 + 22])).toBe(0)
  })

  test('ignores presses outside the grid', () => {
    const surface = createRippleSurface(10, 10)
    surface.press(-20, 50, 1, 0)
    expect(surface.step()).toBe(false)
  })
})
