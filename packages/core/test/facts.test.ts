import { describe, expect, it } from 'vitest'
import {
  FIRE_GATE,
  FIRE_MIN_N,
  K_PROMOTE,
  NEW_LIFECYCLE,
  confirm,
  contradict,
  firingRate,
  injectable,
  recordExercise,
  score,
} from '../src/index.ts'

/** Build an active fact with `n` confirmations and never injected. */
function active(confirmations: number) {
  let life = NEW_LIFECYCLE
  for (let ordinal = 1; ordinal <= confirmations; ordinal += 1) life = confirm(life, ordinal)
  return life
}

describe('promotion', () => {
  it('stays a candidate until three distinct tasks agree', () => {
    let life = confirm(NEW_LIFECYCLE, 1)
    life = confirm(life, 2)
    expect(life.state).toBe('candidate')
    life = confirm(life, K_PROMOTE)
    expect(life.state).toBe('active')
  })

  it('counts a task once however often it repeats', () => {
    const life = confirm(confirm(NEW_LIFECYCLE, 5), 5)
    expect(life.confirms).toEqual([5])
  })

  it('does not resurrect a retired fact', () => {
    const retired = contradict(contradict(active(3), 4), 5)
    expect(retired.state).toBe('retired')
    expect(confirm(retired, 5).state).toBe('retired')
  })
})

describe('score', () => {
  it('decays confirmation credit with distance', () => {
    const life = active(1)
    expect(score(life, 1)).toBeCloseTo(1, 6)
    expect(score(life, 2)).toBeCloseTo(0.8, 6)
    expect(score(life, 3)).toBeCloseTo(0.64, 6)
  })

  it('charges a contradiction five confirmations', () => {
    const life = { ...NEW_LIFECYCLE, confirms: [1], contradicts: [1] }
    expect(score(life, 1)).toBeCloseTo(1 - 5, 6)
  })
})

describe('injection gate', () => {
  it('refuses to inject before the situation has been exercised enough', () => {
    let life = active(3)
    for (let index = 0; index < FIRE_MIN_N - 1; index += 1) life = recordExercise(life, true, true)
    expect(injectable(life, 10)).toBe(false)
  })

  it('injects while the waste keeps recurring', () => {
    let life = active(3)
    for (let index = 0; index < FIRE_MIN_N; index += 1) life = recordExercise(life, true, true)
    expect(firingRate(life)).toBe(1)
    expect(injectable(life, 10)).toBe(true)
  })

  it('stops injecting once the model has absorbed the fact', () => {
    let life = active(3)
    for (let index = 0; index < FIRE_MIN_N - 1; index += 1) life = recordExercise(life, true, false)
    life = recordExercise(life, true, false)
    expect(firingRate(life)).toBe(0)
    expect(firingRate(life)).toBeLessThan(FIRE_GATE)
    expect(injectable(life, 10)).toBe(false)
  })

  it('never injects a candidate', () => {
    let life = confirm(NEW_LIFECYCLE, 1)
    for (let index = 0; index < FIRE_MIN_N; index += 1) life = recordExercise(life, true, true)
    expect(injectable(life, 10)).toBe(false)
  })
})

describe('contradiction', () => {
  it('survives one contradiction, so one noisy success is not a reversal', () => {
    const once = contradict(active(3), 4)
    expect(once.state).toBe('active')
    expect(score(once, 4)).toBeLessThan(0)
  })

  it('retires an active fact once two distinct tasks contradict it', () => {
    const life = contradict(contradict(active(3), 4), 5)
    expect(life.state).toBe('retired')
  })

  it('counts one contradiction per task even if reported twice', () => {
    const life = contradict(contradict(active(3), 4), 4)
    expect(life.state).toBe('active')
    expect(life.contradicts).toEqual([4])
  })

  it('drops an unproven candidate rather than promoting it later', () => {
    const life = contradict(contradict(confirm(NEW_LIFECYCLE, 1), 2), 3)
    expect(life.state).toBe('retired')
    expect(score(life, 3)).toBeLessThan(0)
  })
})
