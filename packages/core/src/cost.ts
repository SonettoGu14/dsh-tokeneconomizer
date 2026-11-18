/**
 * Bucket arithmetic for the cache-weighted equivalent-token metric.
 *
 * Pure functions only: the plugin owns timers, sessions and files, this module
 * owns the numbers so they can be tested against a hand-computed fixture.
 * @module dsh-te-core/cost
 */

import type { TokenWeights } from './pricing.ts'

/** One assistant call's provider-reported usage. */
export interface UsageSample {
  /** Uncached input (billed input minus the two cache classes). */
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** The same four disjoint buckets, accumulated. */
export interface TokenBuckets {
  readonly uncachedInput: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

/** The additive identity. */
export const ZERO_BUCKETS: TokenBuckets = Object.freeze({
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
})

/**
 * Normalize one usage sample into buckets.
 * @param sample - provider usage for one assistant call.
 * @returns the four buckets, absent cache classes counted as zero.
 */
export function sampleBuckets(sample: UsageSample): TokenBuckets {
  return {
    uncachedInput: sample.inputTokens,
    cacheRead: sample.cacheReadTokens ?? 0,
    cacheWrite: sample.cacheWriteTokens ?? 0,
    output: sample.outputTokens,
  }
}

/**
 * Add two bucket sets.
 * @param a - base buckets.
 * @param b - buckets to add.
 * @returns a new bucket set.
 */
export function addBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  }
}

/**
 * Raw token count across all four buckets (what a bill-less meter would report).
 * @param buckets - buckets to sum.
 * @returns the sum.
 */
export function bucketsTotal(buckets: TokenBuckets): number {
  return buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite + buckets.output
}

/**
 * Price one bucket set into equivalent fresh-input tokens.
 * @param buckets - accumulated buckets.
 * @param weights - the route's price ratios.
 * @returns equivalent tokens, in the metric's unit.
 */
export function equivalentTokens(buckets: TokenBuckets, weights: TokenWeights): number {
  return (
    buckets.uncachedInput * weights.input +
    buckets.cacheRead * weights.cacheRead +
    buckets.cacheWrite * weights.cacheWrite +
    buckets.output * weights.output
  )
}

/**
 * Price one usage sample directly.
 * @param sample - provider usage for one call.
 * @param weights - the route's price ratios.
 * @returns equivalent tokens for that call.
 */
export function sampleEquivalent(sample: UsageSample, weights: TokenWeights): number {
  return equivalentTokens(sampleBuckets(sample), weights)
}

/** A running per-session total: the buckets, their price, and the call count. */
export interface CostAccumulator {
  readonly buckets: TokenBuckets
  readonly equivalent: number
  readonly messages: number
}

/** The zero accumulator. */
export const EMPTY_ACCUMULATOR: CostAccumulator = Object.freeze({
  buckets: ZERO_BUCKETS,
  equivalent: 0,
  messages: 0,
})

/**
 * Fold one usage sample into an accumulator.
 *
 * Weights are supplied per sample because a session may switch route mid-flight;
 * each call is priced with the weights that were in force for it.
 *
 * @param accumulator - totals so far.
 * @param sample - provider usage for one call.
 * @param weights - the route's price ratios for that call.
 * @returns the new totals.
 */
export function foldUsage(accumulator: CostAccumulator, sample: UsageSample, weights: TokenWeights): CostAccumulator {
  const buckets = sampleBuckets(sample)
  return {
    buckets: addBuckets(accumulator.buckets, buckets),
    equivalent: accumulator.equivalent + equivalentTokens(buckets, weights),
    messages: accumulator.messages + 1,
  }
}
