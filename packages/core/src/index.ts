/**
 * Pure building blocks shared by every TokenEconomizer component.
 *
 * Nothing here touches a DSH service or a session: this package is deliberately
 * framework-free so its maths is unit-testable and reusable outside DSH.
 *
 * @module @gyk/dsh-te-core
 */

export const CORE_VERSION = '0.1.0'

export {
  DEFAULT_WEIGHTS,
  DEEPSEEK_FLASH_WEIGHTS,
  DEEPSEEK_PRO_WEIGHTS,
  CLAUDE_5_WEIGHTS,
  GPT_5_6_SOL_WEIGHTS,
  PRO_FOLDED_INTO_FLASH_AT_MS,
  weightsFor,
} from './pricing.ts'
export type { TokenWeights } from './pricing.ts'

export {
  EMPTY_ACCUMULATOR,
  ZERO_BUCKETS,
  addBuckets,
  bucketsTotal,
  equivalentTokens,
  sampleBuckets,
  sampleEquivalent,
  foldUsage,
} from './cost.ts'
export type { CostAccumulator, TokenBuckets, UsageSample } from './cost.ts'

export { gitOriginRemote, normalizeRemoteUrl, repoKeyDirName, resolveRepoKey } from './repo-key.ts'
export type { RepoIdentity, RepoKeySource } from './repo-key.ts'

export { formatTokens } from './format.ts'

export { STATE_DIR_NAME, expandHome, readJson, resolveDshHome, stateRoot, writeJsonAtomic } from './storage.ts'
