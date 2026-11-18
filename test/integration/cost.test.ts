import { afterEach, describe, expect, it } from 'vitest'

import { startHarness, type Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('cost, end to end', () => {
  it('folds the four reported buckets into cache-weighted equivalents', async () => {
    harness = await startHarness({
      components: ['cost'],
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5 },
    })
    const agent = await harness.agent()
    await harness.turn(agent, 'say done')
    await harness.end(agent)

    expect(harness.requests).toHaveLength(1)
    const record = harness.readRepo('cost.json') as
      | {
          version: number
          equivalent: number
          buckets: Record<string, number>
          sessions: number
          history: { sessionId: string; day: string; equivalent: number }[]
          droppedSessions: number
        }
      | undefined
    expect(record).toBeDefined()
    expect(record?.version).toBe(2)
    expect(record?.history).toHaveLength(1)
    expect(record?.history[0]?.equivalent).toBeCloseTo(211.25, 6)
    expect(record?.history[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(record?.droppedSessions).toBe(0)
    // Default weights for an unlisted model: 1 / 0.1 / 1.25 / 5.
    // 100×1 + 50×0.1 + 5×1.25 + 20×5 = 211.25
    expect(record?.buckets).toEqual({
      uncachedInput: 100,
      cacheRead: 50,
      cacheWrite: 5,
      output: 20,
    })
    expect(record?.equivalent).toBeCloseTo(211.25, 6)
    expect(record?.sessions).toBe(1)
  })

  it('accumulates two sessions in the same repository', async () => {
    harness = await startHarness({
      components: ['cost'],
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })

    const first = await harness.agent()
    await harness.turn(first)
    await harness.end(first)

    const second = await harness.agent()
    await harness.turn(second)
    await harness.end(second)

    const record = harness.readRepo('cost.json') as
      | {
          equivalent: number
          sessions: number
          buckets: Record<string, number>
          history: { sessionId: string }[]
        }
      | undefined
    // Two requests of 10×1 + 2×5 = 20 each.
    expect(record?.sessions).toBe(2)
    expect(record?.equivalent).toBeCloseTo(40, 6)
    expect(record?.buckets.uncachedInput).toBe(20)
    expect(record?.history).toHaveLength(2)
  })

  it('answers /te-cost repo with the history it recorded', async () => {
    harness = await startHarness({ components: ['cost'] })
    const first = await harness.agent()
    await harness.turn(first)
    await harness.end(first)

    const second = await harness.agent()
    const result = await harness.command(second, '/te-cost repo')
    expect(result?.kind).toBe('success')
    expect(result?.text).toContain('history 1 sessions')
  })
})
