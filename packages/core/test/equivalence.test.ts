import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEIGHTS,
  DEEPSEEK_FLASH_WEIGHTS,
  EMPTY_ACCUMULATOR,
  bucketsTotal,
  equivalentTokens,
  foldUsage,
  sampleBuckets,
} from '../src/index.ts'

describe('sampleBuckets', () => {
  it('keeps the four buckets disjoint', () => {
    const buckets = sampleBuckets({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 30,
    })
    expect(buckets).toEqual({ uncachedInput: 100, cacheRead: 900, cacheWrite: 30, output: 20 })
    expect(bucketsTotal(buckets)).toBe(1050)
  })

  it('treats absent cache fields as zero', () => {
    expect(sampleBuckets({ inputTokens: 5, outputTokens: 1 })).toEqual({
      uncachedInput: 5,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1,
    })
  })
})

describe('equivalentTokens', () => {
  it('prices a hand-computed flash sample', () => {
    // 1000 uncached (×1) + 10_000 cache read (×0.02) + 500 output (×4)
    const buckets = sampleBuckets({ inputTokens: 1000, cacheReadTokens: 10_000, outputTokens: 500 })
    expect(equivalentTokens(buckets, DEEPSEEK_FLASH_WEIGHTS)).toBeCloseTo(1000 + 200 + 2000, 6)
  })

  it('makes a cache-heavy prompt cheaper than a small uncached one', () => {
    const cached = sampleBuckets({ inputTokens: 0, cacheReadTokens: 20_000, outputTokens: 0 })
    const fresh = sampleBuckets({ inputTokens: 1000, outputTokens: 0 })
    expect(equivalentTokens(cached, DEEPSEEK_FLASH_WEIGHTS)).toBeLessThan(
      equivalentTokens(fresh, DEEPSEEK_FLASH_WEIGHTS),
    )
  })

  it('charges a cache write at the write price, not at the fresh price', () => {
    // 100 cache-write tokens: flash writes at 1x, the default row at 1.25x.
    const buckets = sampleBuckets({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 100 })
    expect(equivalentTokens(buckets, DEEPSEEK_FLASH_WEIGHTS)).toBeCloseTo(100, 6)
    expect(equivalentTokens(buckets, DEFAULT_WEIGHTS)).toBeCloseTo(125, 6)
  })

  it('bills output far above cached input on the default row', () => {
    const out = sampleBuckets({ inputTokens: 0, outputTokens: 100 })
    const cached = sampleBuckets({ inputTokens: 0, cacheReadTokens: 100, outputTokens: 0 })
    expect(equivalentTokens(out, DEFAULT_WEIGHTS)).toBeGreaterThan(equivalentTokens(cached, DEFAULT_WEIGHTS) * 10)
  })
})

describe('foldUsage', () => {
  it('accumulates buckets, equivalent tokens and call count', () => {
    const once = foldUsage(EMPTY_ACCUMULATOR, { inputTokens: 100, outputTokens: 10 }, DEEPSEEK_FLASH_WEIGHTS)
    const twice = foldUsage(once, { inputTokens: 100, outputTokens: 10 }, DEEPSEEK_FLASH_WEIGHTS)
    expect(twice.messages).toBe(2)
    expect(twice.buckets).toEqual({ uncachedInput: 200, cacheRead: 0, cacheWrite: 0, output: 20 })
    expect(twice.equivalent).toBeCloseTo(2 * (100 + 40), 6)
  })

  it('does not mutate the previous accumulator', () => {
    const before = EMPTY_ACCUMULATOR
    foldUsage(before, { inputTokens: 7, outputTokens: 3 }, DEFAULT_WEIGHTS)
    expect(before).toEqual({ buckets: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, equivalent: 0, messages: 0 })
  })

  it('prices each call with the weights in force for it', () => {
    const flash = foldUsage(EMPTY_ACCUMULATOR, { inputTokens: 100, outputTokens: 0 }, DEEPSEEK_FLASH_WEIGHTS)
    const mixed = foldUsage(flash, { inputTokens: 100, outputTokens: 0 }, DEFAULT_WEIGHTS)
    expect(mixed.equivalent).toBeCloseTo(100 + 100, 6)
  })
})
