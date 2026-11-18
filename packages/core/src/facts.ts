/**
 * The fact lifecycle: how one observation becomes a claim worth injecting, and
 * how it dies.
 *
 * This is the piece that makes injection defensible. A fact is not shown to the
 * model because it was observed; it is shown once it has been *confirmed across
 * separate tasks* (so it is a property of the repository, not of one attempt)
 * and only while the waste it prevents is still happening at a rate that pays
 * for its own tokens.
 *
 * Ported from TokenEconomizer's `microskills/lifecycle.py`, with the same
 * constants and the same asymmetry: evidence decays with distance, and a
 * contradiction costs five times what a confirmation earns.
 *
 * @module dsh-te-core/facts
 */

/** Confirmations in distinct tasks before a fact may be injected. */
export const K_PROMOTE = 3
/** Recency decay: a confirmation `d` tasks ago is worth `GAMMA ** d`. */
export const GAMMA = 0.8
/** A contradiction costs this many confirmations. */
export const LAMBDA = 5
/** Below this score an active fact is retired. */
export const SCORE_FLOOR = 0
/**
 * Contradictions in this many distinct tasks before a fact dies.
 *
 * One noisy success is not evidence: a suite that happened to need none of the
 * missing packages, or a wrapper that happened to work, should not erase a fact
 * that three earlier tasks confirmed. The reference implementation uses the same
 * two-strike rule for form repairs.
 */
export const CONTRADICT_STREAK = 2
/**
 * Evidence older than this many tasks is dropped.
 *
 * A confirmation from a year ago says little about the repository today, and an
 * unbounded array is a memory and serialization problem in a long-lived repo.
 */
export const EVIDENCE_WINDOW = 20

/** Injected facts must still be paying for themselves this often. */
export const FIRE_GATE = 0.4
/** ... and only after this many exercised tasks, so one bad session cannot kill it. */
export const FIRE_MIN_N = 4

/** Where a fact sits in its life. */
export type FactState = 'candidate' | 'active' | 'retired'

/** The bookkeeping every fact carries. */
export interface FactLifecycle {
  /** Task ordinals in which the fact was confirmed. */
  readonly confirms: readonly number[]
  /** Task ordinals in which it was contradicted. */
  readonly contradicts: readonly number[]
  /** Tasks in which the fact was injected and its situation actually arose. */
  readonly fired: number
  /** Of those, tasks where the waste it prevents still happened. */
  readonly firedWaste: number
  readonly state: FactState
}

/** A fact that has never been observed. */
export const NEW_LIFECYCLE: FactLifecycle = Object.freeze({
  confirms: [],
  contradicts: [],
  fired: 0,
  firedWaste: 0,
  state: 'candidate',
})

/**
 * Recency-weighted evidence score.
 * @param life - the lifecycle to score.
 * @param now - the current task ordinal.
 * @returns confirmations minus `LAMBDA`× contradictions, both decayed.
 */
export function score(life: FactLifecycle, now: number): number {
  let total = 0
  for (const ordinal of life.confirms) total += GAMMA ** Math.max(0, now - ordinal)
  for (const ordinal of life.contradicts) total -= LAMBDA * GAMMA ** Math.max(0, now - ordinal)
  return total
}

/**
 * The share of injected tasks in which the waste still happened.
 * @returns a rate in [0, 1]; 0 when never injected.
 */
export function firingRate(life: FactLifecycle): number {
  return life.fired === 0 ? 0 : life.firedWaste / life.fired
}

/**
 * Whether this fact earns its tokens right now.
 *
 * Two gates: it must be active with enough cross-task evidence, and the waste
 * it prevents must still be happening in at least `FIRE_GATE` of the tasks
 * where it was exercised — otherwise the model has learned it and the fact is
 * pure overhead.
 */
export function injectable(life: FactLifecycle, now: number): boolean {
  if (life.state !== 'active') return false
  if (score(life, now) <= SCORE_FLOOR) return false
  if (life.fired < FIRE_MIN_N) return false
  return firingRate(life) >= FIRE_GATE
}

/**
 * Fold one confirmation.
 *
 * A task confirms a fact once, no matter how many times it is seen inside that
 * task: three repeats inside one session are one piece of evidence, not three.
 *
 * @param life - lifecycle so far.
 * @param now - the task ordinal the confirmation belongs to.
 * @returns the updated lifecycle, promoted to `active` once enough distinct
 * tasks agree.
 */
export function confirm(life: FactLifecycle, now: number): FactLifecycle {
  if (life.state === 'retired') return life
  if (life.confirms.includes(now)) return life
  const confirms = [...life.confirms, now].slice(-EVIDENCE_WINDOW)
  const promoted = life.state === 'active' || confirms.length >= K_PROMOTE
  return {
    ...life,
    confirms,
    state: promoted ? 'active' : 'candidate',
  }
}

/**
 * Fold one contradiction.
 *
 * A contradiction costs `LAMBDA` confirmations, and a fact is retired once its
 * score is spent — but only after contradictions in `CONTRADICT_STREAK` distinct
 * tasks. Retired is terminal for this build: a fact that comes back should be
 * re-learned, not resurrected with a stale history.
 *
 * @param life - lifecycle so far.
 * @param now - the task ordinal the contradiction belongs to.
 * @returns the updated lifecycle.
 */
export function contradict(life: FactLifecycle, now: number): FactLifecycle {
  if (life.state === 'retired') return life
  if (life.contradicts.includes(now)) return life
  const contradicts = [...life.contradicts, now].slice(-EVIDENCE_WINDOW)
  const next: FactLifecycle = { ...life, contradicts }
  if (contradicts.length < CONTRADICT_STREAK) return next
  if (score(next, now) <= SCORE_FLOOR) return { ...next, state: 'retired' }
  return next
}

/**
 * Record one task in which the fact's situation arose.
 *
 * "Exercised" is independent of injection: the situation counts whenever the
 * task touched the fact's intent, whether or not the fact was shown. That is
 * what lets a fact be measured *before* it is ever injected, and what stops an
 * unexercised fact from looking like a free win.
 *
 * @param life - lifecycle so far.
 * @param exercised - whether the task touched the fact's situation at all.
 * @param waste - whether the waste the fact prevents happened in this task.
 * @returns the updated lifecycle.
 */
export function recordExercise(life: FactLifecycle, exercised: boolean, waste: boolean): FactLifecycle {
  if (!exercised) return life
  return {
    ...life,
    fired: life.fired + 1,
    firedWaste: life.firedWaste + (waste ? 1 : 0),
  }
}
