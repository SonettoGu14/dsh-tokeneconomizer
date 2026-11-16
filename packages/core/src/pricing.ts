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
 * - Anthropic Claude 5 family: a 5m cache write bills at 125%, output at 5×.
 *   Cache reads are *not* uniform across the family: 10% of input on the older
 *   ids, 5% on `claude-(opus|sonnet)-5-5`, 2.5% on `claude-(fable|mythos)-5-[12]`.
 *   Cache reads are the bulk of a long session, so one ratio cannot stand in for
 *   the other. A 1h cache write bills at 200%; DSH's usage projection reports one
 *   cache-write bucket, so this table prices every write at the 5m rate — an
 *   under-count that keeps the metric honest rather than inflating it.
 * - OpenAI: GPT-5.6 Sol cache read 10%, cache write 125%, output 6×;
 *   GPT-5.3 Codex cache read 9.71%, no separate cache-write class, output 8×;
 *   GPT-5.5 / luna / terra cache read 10%, cache write 125%, output 6×.
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

/** Claude Opus/Sonnet 5.5: cache reads bill at 5%, not 10%. */
export const CLAUDE_5_5_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 0.05,
  cacheWrite: 1.25,
  output: 5,
}

/** Claude Fable/Mythos 5.1-5.2: cache reads bill at 2.5%. */
export const CLAUDE_FABLE_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 0.025,
  cacheWrite: 1.25,
  output: 5,
}

/** OpenAI GPT-5.3 Codex: no separate cache-write class, output 8x. */
export const GPT_5_3_CODEX_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 0.0971,
  cacheWrite: 0,
  output: 8,
}

/** OpenAI GPT-5.5 / luna / terra. */
export const GPT_5_5_WEIGHTS: TokenWeights = {
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  output: 6,
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
export type WeightsSource =
  | 'deepseek-flash'
  | 'deepseek-pro'
  | 'claude-5'
  | 'claude-5-5'
  | 'claude-fable'
  | 'gpt-5.6-sol'
  | 'gpt-5.3-codex'
  | 'gpt-5.5'
  | 'default'

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
  const raw = model.trim().toLowerCase()
  if (raw === '') return { weights: DEFAULT_WEIGHTS, source: 'default' }
  // A router writes `provider/model`; match the full id *and* the bare id, so
  // `deepseek/v4.1-flash` is still recognised as a DeepSeek row rather than
  // losing its only family token to the prefix strip.
  const stripped = raw.replace(/^[^/]+\//, '')
  const ids = stripped === raw ? [raw] : [raw, stripped]
  const any = (pattern: RegExp): boolean => ids.some((id) => pattern.test(id))

  if (any(/deepseek/)) {
    if (any(/pro/) && atMs < PRO_FOLDED_INTO_FLASH_AT_MS) {
      return { weights: DEEPSEEK_PRO_WEIGHTS, source: 'deepseek-pro' }
    }
    return { weights: DEEPSEEK_FLASH_WEIGHTS, source: 'deepseek-flash' }
  }
  if (any(/claude-(opus|sonnet)-5-5/)) return { weights: CLAUDE_5_5_WEIGHTS, source: 'claude-5-5' }
  if (any(/claude-(fable|mythos)-5-[12]/)) return { weights: CLAUDE_FABLE_WEIGHTS, source: 'claude-fable' }
  if (any(/claude/)) return { weights: CLAUDE_5_WEIGHTS, source: 'claude-5' }
  if (any(/gpt-5\.3-codex/)) return { weights: GPT_5_3_CODEX_WEIGHTS, source: 'gpt-5.3-codex' }
  if (any(/gpt-5\.6/) && any(/sol/)) return { weights: GPT_5_6_SOL_WEIGHTS, source: 'gpt-5.6-sol' }
  if (any(/gpt-5\.5|luna|terra/)) return { weights: GPT_5_5_WEIGHTS, source: 'gpt-5.5' }
  return { weights: DEFAULT_WEIGHTS, source: 'default' }
}
