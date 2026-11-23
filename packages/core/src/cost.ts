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

/** How many finished sessions a repository keeps day-level detail for. */
export const HISTORY_CAP = 400

/**
 * One finished session, as the trend reports need it.
 *
 * The aggregate record cannot answer "is this getting worse?" — it only moves
 * up. One entry per session can, at the cost of a few hundred bytes each, so
 * the cap keeps a long-lived repository from growing without bound.
 */
export interface SessionHistoryEntry {
  /** The DSH session id; the key that makes a re-settle an update, not a duplicate. */
  readonly sessionId: string
  /** Local calendar day the session ended, `YYYY-MM-DD`; trend buckets are days. */
  readonly day: string
  readonly startedAt: string
  readonly endedAt: string
  readonly equivalent: number
  readonly buckets: TokenBuckets
  readonly overhead: Record<string, number>
  readonly weightsSource: string
  /** A delegated child session: counted in the totals, excluded from per-session averages. */
  readonly subagent?: true
}

/**
 * The local calendar day of an instant.
 *
 * Local, not UTC: a session that ends at 23:30 belongs to that day for the
 * person who ran it, whatever the timezone offset.
 *
 * @param iso - an ISO timestamp.
 * @returns `YYYY-MM-DD`, or an empty string for an unparsable instant.
 */
export function localDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Insert one session entry, replacing an earlier entry for the same session.
 *
 * A session can be settled more than once (resume, a second flush), and a
 * duplicate entry would double-count it in every average.
 *
 * @param history - entries so far, oldest first.
 * @param entry - the entry to add or replace.
 * @returns a new array; the input is not mutated.
 */
export function upsertHistory(
  history: readonly SessionHistoryEntry[],
  entry: SessionHistoryEntry,
): SessionHistoryEntry[] {
  const index = history.findIndex((candidate) => candidate.sessionId === entry.sessionId)
  if (index < 0) return [...history, entry]
  const next = [...history]
  next[index] = entry
  return next
}

/**
 * Drop the oldest entries beyond the cap.
 * @param history - entries, oldest first.
 * @param cap - how many to keep.
 * @returns the kept entries and how many were dropped.
 */
export function capHistory(
  history: readonly SessionHistoryEntry[],
  cap: number = HISTORY_CAP,
): { entries: SessionHistoryEntry[]; dropped: number } {
  const dropped = Math.max(0, history.length - cap)
  return { entries: dropped === 0 ? [...history] : history.slice(dropped), dropped }
}

/** One calendar day of a repository's session history. */
export interface TrendDay {
  /** `YYYY-MM-DD`, local. */
  readonly day: string
  readonly sessions: number
  readonly equivalent: number
}

/**
 * Group session history into calendar days, oldest first.
 *
 * The ledger stores one entry per session; a trend needs one line per day,
 * because a day is the unit a person compares ("before I enabled this").
 *
 * @param history - entries, oldest first (any order is accepted).
 * @returns one bucket per day that has at least one entry.
 */
export function dailyTrend(history: readonly SessionHistoryEntry[]): TrendDay[] {
  const byDay = new Map<string, { sessions: number; equivalent: number }>()
  for (const entry of history) {
    if (entry.day === '') continue
    const bucket = byDay.get(entry.day) ?? { sessions: 0, equivalent: 0 }
    bucket.sessions += 1
    bucket.equivalent += entry.equivalent
    byDay.set(entry.day, bucket)
  }
  return [...byDay.entries()]
    .map(([day, bucket]) => ({ day, sessions: bucket.sessions, equivalent: bucket.equivalent }))
    .sort((left, right) => left.day.localeCompare(right.day))
}

/**
 * The middle value, or the mean of the two middle values.
 *
 * The trend report quotes a median per session because one runaway session
 * would drag a mean and make a before/after comparison say the opposite of what
 * happened.
 *
 * @param values - the sample; an empty array yields 0.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

/** Whether a stored entry is still shaped the way this version writes it. */
export function isSessionHistoryEntry(value: unknown): value is SessionHistoryEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<SessionHistoryEntry>
  return (
    typeof entry.sessionId === 'string' &&
    typeof entry.day === 'string' &&
    typeof entry.equivalent === 'number' &&
    typeof entry.endedAt === 'string' &&
    typeof entry.weightsSource === 'string' &&
    typeof entry.buckets === 'object' &&
    entry.buckets !== null
  )
}
