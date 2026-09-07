import { describe, expect, it } from 'vitest'
import {
  createSpringState,
  isSpringSettled,
  snapSpring,
  springFromDuration,
  stepSpring,
} from '../utils/spring'

function settle(state: ReturnType<typeof createSpringState>, target: number, seconds: number) {
  const step = 1 / 60
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    stepSpring(state, target, springFromDuration(0.5, 0.9), step)
  }
  return state
}

describe('spring', () => {
  it('converges to the target and stops', () => {
    const state = createSpringState(120)
    settle(state, 0, 1.5)

    expect(Math.abs(state.value)).toBeLessThan(0.5)
    expect(isSpringSettled(state, 0)).toBe(true)
  })

  it('keeps velocity across a retarget instead of restarting from rest', () => {
    const config = springFromDuration(0.5, 0.9)
    const state = createSpringState(120)
    for (let frame = 0; frame < 6; frame += 1) stepSpring(state, 0, config, 1 / 60)

    const movingVelocity = state.velocity
    expect(Math.abs(movingVelocity)).toBeGreaterThan(1)

    // 改目标不改速度:这正是弹簧可被随时打断而不产生速度突变的原因
    state.value += 80
    stepSpring(state, 0, config, 1 / 60)
    expect(Math.sign(state.velocity)).toBe(Math.sign(movingVelocity))
  })

  it('stays stable when a frame is dropped instead of exploding', () => {
    const config = springFromDuration(0.4, 0.9)
    const state = createSpringState(200)

    // 单帧 120ms(掉帧):显式积分在这种步长下会发散,子步积分不会
    stepSpring(state, 0, config, 0.12)
    expect(Number.isFinite(state.value)).toBe(true)
    expect(Math.abs(state.value)).toBeLessThanOrEqual(200)
  })

  it('snaps to the target when a whole frame budget was skipped', () => {
    const state = createSpringState(200, 900)
    // 超过 0.25s 视为"这一帧根本没渲染",直接吸附而不是把整段时长积分掉
    stepSpring(state, 0, springFromDuration(0.5, 0.9), 1.2)

    expect(state.value).toBe(0)
    expect(state.velocity).toBe(0)
  })

  it('ignores non-positive and non-finite time steps', () => {
    const state = createSpringState(50, 10)
    stepSpring(state, 0, springFromDuration(0.5, 0.9), 0)
    stepSpring(state, 0, springFromDuration(0.5, 0.9), Number.NaN)

    expect(state.value).toBe(50)
    expect(state.velocity).toBe(10)
  })

  it('overshoots below critical damping and does not above it', () => {
    const underdamped = createSpringState(100)
    const overdamped = createSpringState(100)
    let minUnder = 100
    let minOver = 100

    for (let frame = 0; frame < 120; frame += 1) {
      stepSpring(underdamped, 0, springFromDuration(0.4, 0.35), 1 / 60)
      stepSpring(overdamped, 0, springFromDuration(0.4, 1.4), 1 / 60)
      minUnder = Math.min(minUnder, underdamped.value)
      minOver = Math.min(minOver, overdamped.value)
    }

    expect(minUnder).toBeLessThan(-1)
    expect(minOver).toBeGreaterThanOrEqual(-0.5)
  })

  it('reports unsettled while passing through the target at speed', () => {
    // 只看位置会在过冲顶点误判为静止,必须位置与速度同时进入阈值
    expect(isSpringSettled({ value: 0, velocity: 40 }, 0)).toBe(false)
    expect(isSpringSettled({ value: 0.1, velocity: 0.1 }, 0)).toBe(true)
  })

  it('snapSpring clears position and velocity', () => {
    expect(snapSpring(createSpringState(30, 12), 5)).toEqual({ value: 5, velocity: 0 })
  })
})
