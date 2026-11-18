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
  injectionSplit,
  recordExercise,
  recordInjection,
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
    for (let index = 0; index < FIRE_MIN_N - 1; index += 1) life = recordExercise(life, 10 + index, true, true)
    expect(injectable(life, 10)).toBe(false)
  })

  it('injects while the waste keeps recurring', () => {
    let life = active(3)
    for (let index = 0; index < FIRE_MIN_N; index += 1) life = recordExercise(life, 10 + index, true, true)
    expect(firingRate(life)).toBe(1)
    expect(injectable(life, 10)).toBe(true)
  })

  it('stops injecting once the model has absorbed the fact', () => {
    let life = active(3)
    for (let index = 0; index < FIRE_MIN_N - 1; index += 1) life = recordExercise(life, 10 + index, true, false)
    life = recordExercise(life, 20, true, false)
    expect(firingRate(life)).toBe(0)
    expect(firingRate(life)).toBeLessThan(FIRE_GATE)
    expect(injectable(life, 10)).toBe(false)
  })

  it('never injects a candidate', () => {
    let life = confirm(NEW_LIFECYCLE, 1)
    for (let index = 0; index < FIRE_MIN_N; index += 1) life = recordExercise(life, 10 + index, true, true)
    expect(injectable(life, 10)).toBe(false)
  })
})

describe('injection accounting', () => {
  it('counts one exercise per task even when reported twice', () => {
    const once = recordExercise(NEW_LIFECYCLE, 7, true, true, 120)
    expect(recordExercise(once, 7, true, true, 120).fired).toBe(1)
    expect(once.wasteTokens).toBe(120)
  })

  it('accumulates waste tokens only for tasks that actually wasted', () => {
    let life = recordExercise(NEW_LIFECYCLE, 7, true, true, 120)
    life = recordExercise(life, 8, true, false, 999)
    expect(life.wasteTokens).toBe(120)
    expect(life.wastedTasks).toEqual([7])
    expect(life.exercisedTasks).toEqual([7, 8])
  })

  it('books an injection once per task and sums its tokens', () => {
    const first = recordInjection(NEW_LIFECYCLE, 4, 30)
    const again = recordInjection(first, 4, 30)
    expect(again.injectedTasks).toEqual([4])
    expect(again.injectedTokens).toBe(30)
    expect(recordInjection(again, 9, 10).injectedTokens).toBe(40)
  })

  it('does not book an injection into a retired fact', () => {
    const retired = contradict(contradict(active(3), 4), 5)
    expect(recordInjection(retired, 6, 10).injectedTasks).toEqual([])
  })

  it('splits exercise around the first injection, never by ordinal order', () => {
    let life = recordExercise(NEW_LIFECYCLE, 2, true, true, 10)
    life = recordExercise(life, 3, true, false, 0)
    life = recordInjection(life, 5, 40)
    // An exercise recorded late still belongs before the split by its ordinal.
    life = recordExercise(life, 4, true, true, 10)
    life = recordExercise(life, 6, true, false, 0)
    const split = injectionSplit(life)
    expect(split.injectedTasks).toBe(1)
    expect(split.injectedTokens).toBe(40)
    expect(split.before).toEqual({ tasks: 3, waste: 2 })
    expect(split.after).toEqual({ tasks: 1, waste: 0 })
  })

  it('reports everything as before when the fact was never injected', () => {
    const life = recordExercise(NEW_LIFECYCLE, 2, true, true, 10)
    expect(injectionSplit(life)).toEqual({
      injectedTasks: 0,
      injectedTokens: 0,
      before: { tasks: 1, waste: 1 },
      after: { tasks: 0, waste: 0 },
    })
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
