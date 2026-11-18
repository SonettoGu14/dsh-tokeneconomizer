/**
 * Pure building blocks shared by every TokenEconomizer component.
 *
 * Nothing here touches a DSH service or a session: this package is deliberately
 * framework-free so its maths is unit-testable and reusable outside DSH.
 *
 * @module dsh-te-core
 */

export const CORE_VERSION = '0.1.0'

export {
  DEFAULT_WEIGHTS,
  DEEPSEEK_FLASH_WEIGHTS,
  DEEPSEEK_PRO_WEIGHTS,
  CLAUDE_5_5_WEIGHTS,
  CLAUDE_5_WEIGHTS,
  CLAUDE_FABLE_WEIGHTS,
  GPT_5_3_CODEX_WEIGHTS,
  GPT_5_5_WEIGHTS,
  GPT_5_6_SOL_WEIGHTS,
  PRO_FOLDED_INTO_FLASH_AT_MS,
  weightsFor,
} from './pricing.ts'
export type { TokenWeights } from './pricing.ts'

export {
  EMPTY_ACCUMULATOR,
  HISTORY_CAP,
  ZERO_BUCKETS,
  addBuckets,
  bucketsTotal,
  capHistory,
  equivalentTokens,
  isSessionHistoryEntry,
  localDay,
  sampleBuckets,
  sampleEquivalent,
  foldUsage,
  upsertHistory,
} from './cost.ts'
export type { CostAccumulator, SessionHistoryEntry, TokenBuckets, UsageSample } from './cost.ts'

export { gitOriginRemote, gitTopLevel, normalizeRemoteUrl, repoKeyDirName, resolveRepoKey } from './repo-key.ts'
export type { RemoteReader, RepoIdentity, RepoKeySource, TopLevelReader } from './repo-key.ts'

export { formatTokens } from './format.ts'

export { parseArgs } from './args.ts'
export type { ParsedArgs } from './args.ts'

export { STATE_DIR_NAME, expandHome, readJson, resolveDshHome, stateRoot, writeJsonAtomic } from './storage.ts'

export {
  FIRE_GATE,
  FIRE_MIN_N,
  GAMMA,
  CONTRADICT_STREAK,
  EVIDENCE_WINDOW,
  K_PROMOTE,
  LAMBDA,
  NEW_LIFECYCLE,
  SCORE_FLOOR,
  confirm,
  contradict,
  firingRate,
  injectable,
  injectionSplit,
  recordExercise,
  recordInjection,
  score,
} from './facts.ts'
export type { FactLifecycle, FactState, InjectionSplit, InjectionWindow } from './facts.ts'

export {
  contradicted,
  errorClassOf,
  exercised,
  extractFacts,
  formOf,
  intentOf,
  missingEnvOf,
  wasteRecurred,
  wastedCalls,
} from './shell.ts'
export type { FactCandidate, ShellCall } from './shell.ts'
