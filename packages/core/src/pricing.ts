/**
 * How many "fresh uncached input tokens" one token of each usage bucket costs.
 *
 * The unit is deliberately not money: it is the same unit TokenEconomizer uses
 * to compare arms, agents and models whose posted prices differ. Every weight
 * row below is a ratio to that route's uncached-input price, derived from the
 * published price book, so changing the book's absolute price does not move
 * the metric.
 *
 * Sources:
 * - DeepSeek official price page (CNY / Mtok, peak column): V4.1-Flash
 *   cacheHit 0.04, inputMiss 2.0, output 8.0 → 1 / 0.02 / 1 / 4. V4-Pro-0813:
 *   cacheHit 0.3, inputMiss 9.0, output 27.0 → 1 / 1/30 / 1 / 3. DeepSeek
 *   reports no separate cache-write class, so a cache write costs one input.
 * - Anthropic Claude 5 family: cache read bills at 10% of input and a 5m
 *   cache write at 125%, output at 5×.
 * - OpenAI GPT-5.6 Sol: cache read 10%, cache write 125%, output 6×.
 *
 * Unknown ids take {@link DEFAULT_WEIGHTS} instead of failing: a component may
 * never raise into a session just because a new model id appeared.
 * @module @gyk/dsh-te-core/pricing
 */

/** Per-bucket price ratios relative to uncached input tokens (= 1). */
export interface TokenWeights {
  /** Uncached input tokens. */
  readonly input: number
  /** Input served from the provider prompt cache. */
  readonly cacheRead: number
  /** Input written into the provider prompt cache. */
  readonly cacheWrite: number
  /** Output tokens; reasoning output bills as output. */
  readonly output: number
}

/** Fallback used for model ids the table does not know. */
export const DEFAULT_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  output: 5,
}

/** DeepSeek V4.1-Flash and the flash-class ids it now serves. */
export const DEEPSEEK_FLASH_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 0.02,
  cacheWrite: 1,
  output: 4,
}

/** DeepSeek-V4-Pro-0813; only before it folds into the flash row. */
export const DEEPSEEK_PRO_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 1 / 30,
  cacheWrite: 1,
  output: 3,
}

/** Anthropic Claude 5 family (opus / sonnet / fable / mythos). */
export const CLAUDE_5_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  output: 5,
}

/** OpenAI GPT-5.6 Sol. */
export const GPT_5_6_SOL_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  output: 6,
}

/**
 * Instant DeepSeek starts serving `deepseek-v4-pro` from V4.1-Flash and billing
 * the flash row: 2026-09-14 12:00 Beijing (UTC+8).
 */
export const PRO_FOLDED_INTO_FLASH_AT_MS = Date.UTC(2026, 8, 14, 4, 0, 0)

/** Model ids or families whose weights the table resolved. */
export type WeightsSource = 'deepseek-flash' | 'deepseek-pro' | 'claude-5' | 'gpt-5.6-sol' | 'default'

/** One resolved weight lookup. */
export interface WeightLookup {
  /** Price ratios to apply to this route's buckets. */
  readonly weights: TokenWeights
  /** Which row matched, for the report and for tests. */
  readonly source: WeightsSource
}

/**
 * Resolve the weight row for one billed model id.
 * @param model - billed model id (may carry a `provider/` prefix; case-insensitive).
 * @param atMs - instant used for the DeepSeek pro→flash fold; defaults to now.
 * @returns the weights plus which row matched.
 */
export function weightsFor(model: string, atMs: number = Date.now()): WeightLookup {
  const id = model.trim().toLowerCase().replace(/^[^/]+\//, '')
  if (id === '') return { weights: DEFAULT_WEIGHTS, source: 'default' }
  if (id.includes('deepseek')) {
    if (id.includes('pro') && atMs < PRO_FOLDED_INTO_FLASH_AT_MS) {
      return { weights: DEEPSEEK_PRO_WEIGHTS, source: 'deepseek-pro' }
    }
    return { weights: DEEPSEEK_FLASH_WEIGHTS, source: 'deepseek-flash' }
  }
  if (id.includes('claude')) return { weights: CLAUDE_5_WEIGHTS, source: 'claude-5' }
  if (id.includes('gpt-5.6') && id.includes('sol')) return { weights: GPT_5_6_SOL_WEIGHTS, source: 'gpt-5.6-sol' }
  return { weights: DEFAULT_WEIGHTS, source: 'default' }
}
