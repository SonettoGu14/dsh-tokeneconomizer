/**
 * Cache-weighted equivalent-token accounting for DSH sessions.
 *
 * DSH already reports four disjoint provider buckets per request (`inputTokens`
 * uncached, `cacheRead`, `cacheWrite`, `output`). Raw totals are misleading:
 * a cached prompt re-read costs a fraction of a fresh token, so a session that
 * looks 10× more expensive may be the cheaper one. This component converts the
 * buckets into a single unit — *equivalent fresh-input tokens* — using the
 * route's published price ratios, and accumulates it per session and per repo
 * so pruning and fact injection can be judged on the currency that actually
 * bills.
 *
 * The component never changes a prompt: it only observes `session/event`.
 *
 * @module dsh-te-cost
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_WEIGHTS,
  EMPTY_ACCUMULATOR,
  ZERO_BUCKETS,
  addBuckets,
  bucketsTotal,
  foldUsage,
  formatTokens,
  readJson,
  repoKeyDirName,
  resolveRepoKey,
  sampleBuckets,
  stateRoot,
  weightsFor,
  writeJsonAtomic,
  type CostAccumulator,
  type RepoIdentity,
  type TokenBuckets,
  type TokenWeights,
} from 'dsh-te-core'
import { join } from 'node:path'

/** Cordis plugin name; it must match the `cordis.patch.yml` row id/name pair. */
export const name = 'dsh-te-cost'

/** Cache-weighted equivalent-token accounting. */
export interface Config {
  /** Mount this component. Off contributes nothing at all. */
  enabled: boolean
  /** Persist per-repo totals under `<DSH_HOME>/dsh-tokeneconomizer/repos/`. */
  persist: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  persist: z.boolean().default(true),
})

/** The usage fields one assistant message reports, as this component reads them. */
interface ReportedUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** One session's running totals. */
interface SessionCost {
  acc: CostAccumulator
  overhead: Record<string, number>
  provider?: string
  model?: string
  weights: TokenWeights
  weightsSource: string
  repo?: RepoIdentity
  repoResolved: boolean
}

/** What `<...>/repos/<dir>/cost.json` holds. */
interface RepoCostRecord {
  version: 1
  key: string
  equivalent: number
  buckets: TokenBuckets
  sessions: number
  overhead: Record<string, number>
  updatedAt: string
}

/** A read-only view of one session's accounting. */
export interface SessionCostSnapshot {
  readonly provider?: string
  readonly model?: string
  readonly weightsSource: string
  readonly repoKey?: string
  readonly repoSource?: RepoIdentity['source']
  readonly messages: number
  readonly equivalent: number
  readonly overhead: number
  readonly buckets: TokenBuckets
}

/**
 * The `teCost` service: other components read and bill against one definition
 * of cost instead of each inventing its own.
 */
export class CostLedger extends Service {
  static inject = ['commands']

  private readonly states = new WeakMap<Session, SessionCost>()
  private readonly repoKeys = new Map<string, RepoIdentity>()
  private readonly repoCache = new Map<string, RepoCostRecord>()

  /** Settles in flight, awaited by the `session/flush` durability checkpoint. */
  private readonly pending = new Map<string, Promise<void>>()

  /** One write at a time per repository, so concurrent settles cannot drop totals. */
  private readonly settling = new Map<string, Promise<void>>()

  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'teCost')
    this.config = config
  }

  async [Service.init](): Promise<void> {
    const ctx = this.ctx
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.observe(session, event)
    })
    ctx.on('session/disposed', (session: Session) => {
      // Sessions are torn down without awaiting listeners, so the write is
      // handed to the awaited `session/flush` durability checkpoint instead of
      // racing the process exit here.
      this.pending.set(
        session.id,
        this.settle(session)
          .catch((error: unknown) => {
            this.ctx.logger('dsh-te-cost').warn('session totals not persisted: %s', String(error))
          })
          .finally(() => this.pending.delete(session.id)),
      )
    })
    ctx.on('session/flush', async () => {
      await Promise.all([...this.pending.values()])
    })
    ctx.effect(() =>
      ctx.commands.register({
        name: 'te-cost',
        description: 'Show cache-weighted equivalent-token spend for this session and repo',
        input: { hint: 'session | repo' },
        handler: async (invocation) => {
          const session = invocation.agent.session
          // A resumed session has an empty in-memory cache; load the record so
          // `/te-cost repo` answers from disk instead of claiming there is none.
          await this.repoSnapshot(session)
          return { kind: 'success', text: this.report(session, invocation.rawInput) }
        },
      }),
    )
  }

  /** Fold one session event into its running totals. */
  observe(session: Session, event: SessionEvent): void {
    try {
      const state = this.stateOf(session)
      if (event.type === 'request/header' || event.type === 'request/context') {
        const route = readRoute(event)
        if (route === undefined) return
        state.provider = route.provider
        state.model = route.model
        const resolved = weightsFor(route.model ?? '')
        state.weights = resolved.weights
        state.weightsSource = resolved.source
        return
      }
      if (event.type === 'assistant/message') {
        const usage = (event.data as { usage?: ReportedUsage }).usage
        if (usage === undefined) return
        state.acc = foldUsage(
          state.acc,
          {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          },
          state.weights,
        )
      }
    } catch {
      // Accounting must never break the session loop.
    }
  }

  /**
   * Bill this component's own model calls against the same account.
   *
   * A mechanism that spends tokens to save tokens has to say so, or the saving
   * is fiction.
   */
  recordOverhead(session: Session, component: string, equivalent: number): void {
    if (!(equivalent > 0)) return
    const state = this.stateOf(session)
    state.overhead[component] = (state.overhead[component] ?? 0) + equivalent
  }

  /** A read-only snapshot of one session. */
  sessionSnapshot(session: Session): SessionCostSnapshot {
    const state = this.stateOf(session)
    const repo = this.repoOf(session)
    return {
      ...(state.provider === undefined ? {} : { provider: state.provider }),
      ...(state.model === undefined ? {} : { model: state.model }),
      weightsSource: state.weightsSource,
      ...(repo === undefined ? {} : { repoKey: repo.key, repoSource: repo.source }),
      messages: state.acc.messages,
      equivalent: state.acc.equivalent,
      overhead: overheadTotal(state.overhead),
      buckets: state.acc.buckets,
    }
  }

  /** Repo totals, reading the persisted record on first use. */
  async repoSnapshot(session: Session): Promise<RepoCostRecord | undefined> {
    const repo = this.repoOf(session)
    if (repo === undefined) return undefined
    const cached = this.repoCache.get(repo.key)
    if (cached !== undefined) return cached
    if (!this.config.persist) return undefined
    const record = await readJson<RepoCostRecord>(this.recordPath(repo.key))
    if (record !== undefined) this.repoCache.set(repo.key, record)
    return record
  }

  /** Render the `/te-cost` report. */
  report(session: Session, rawInput: string): string {
    const scope = rawInput.trim().toLowerCase()
    const wantRepo = scope === 'repo'
    const wantSession = scope === '' || scope === 'session'
    const state = this.stateOf(session)
    const repo = this.repoOf(session)
    const lines: string[] = ['Token economy — equivalent fresh-input tokens (cache-weighted).', '']

    if (wantSession) {
      lines.push(`session ${session.id.slice(0, 8)}`)
      lines.push(`  model ${state.model ?? 'unknown'} · weights ${state.weightsSource}`)
      lines.push(`  requests ${state.acc.messages}`)
      lines.push(`  equivalent ${formatTokens(state.acc.equivalent)} eq`)
      lines.push(
        `  buckets uncached ${formatTokens(state.acc.buckets.uncachedInput)} · cache read ${formatTokens(state.acc.buckets.cacheRead)} · cache write ${formatTokens(state.acc.buckets.cacheWrite)} · output ${formatTokens(state.acc.buckets.output)}`,
      )
      const overhead = overheadTotal(state.overhead)
      lines.push(`  overhead ${formatTokens(overhead)} eq${describeOverhead(state.overhead)}`)
      lines.push('')
    }

    if (wantRepo) {
      if (repo === undefined) {
        lines.push('repo unknown (session has no working directory yet)')
      } else {
        const record = this.repoCache.get(repo.key)
        if (record === undefined) {
          lines.push(`repo ${repo.key}`)
          lines.push('  no persisted totals yet (written when this session ends)')
        } else {
          lines.push(`repo ${record.key}`)
          lines.push(`  equivalent ${formatTokens(record.equivalent)} eq over ${record.sessions} sessions`)
          lines.push(
            `  buckets uncached ${formatTokens(record.buckets.uncachedInput)} · cache read ${formatTokens(record.buckets.cacheRead)} · cache write ${formatTokens(record.buckets.cacheWrite)} · output ${formatTokens(record.buckets.output)}`,
          )
          lines.push(`  overhead ${formatTokens(overheadTotal(record.overhead))} eq${describeOverhead(record.overhead)}`)
        }
      }
    }

    return lines.join('\n').trimEnd()
  }

  private stateOf(session: Session): SessionCost {
    const existing = this.states.get(session)
    if (existing !== undefined) return existing
    const created: SessionCost = {
      acc: EMPTY_ACCUMULATOR,
      overhead: {},
      weights: DEFAULT_WEIGHTS,
      weightsSource: 'default',
      repoResolved: false,
    }
    this.states.set(session, created)
    return created
  }

  private repoOf(session: Session): RepoIdentity | undefined {
    const state = this.stateOf(session)
    if (state.repoResolved) return state.repo
    const cwd = session.header?.cwd
    if (cwd === undefined || cwd === '') return undefined
    let identity = this.repoKeys.get(cwd)
    if (identity === undefined) {
      identity = resolveRepoKey(cwd)
      this.repoKeys.set(cwd, identity)
    }
    state.repo = identity
    state.repoResolved = true
    return identity
  }

  private recordPath(repoKey: string): string {
    return join(stateRoot(), 'repos', repoKeyDirName(repoKey), 'cost.json')
  }

  /**
   * Fold a finished session into its repo record.
   *
   * Called on `session/disposed`; exposed so a test (or a host shutdown path)
   * can await the write instead of racing it.
   */
  async settle(session: Session): Promise<void> {
    const state = this.states.get(session)
    if (state === undefined || !this.config.persist) return
    const repo = this.repoOf(session)
    if (repo === undefined) return
    if (state.acc.equivalent === 0 && overheadTotal(state.overhead) === 0) return
    // Two sessions can end at once (two tabs, desktop plus CLI). Serialize per
    // repository so one read-modify-write cannot drop the other's totals.
    const previous = this.settling.get(repo.key) ?? Promise.resolve()
    const run = previous.then(() => this.persist(session, state, repo))
    this.settling.set(
      repo.key,
      run.catch(() => {
        // Kept so the next writer still waits for this one to settle.
      }),
    )
    return run
  }

  /** One read-modify-write of a repository's cost record. */
  private async persist(session: Session, state: SessionCost, repo: RepoIdentity): Promise<void> {
    try {
      const previous = await this.repoSnapshot(session)
      const next: RepoCostRecord = {
        version: 1,
        key: repo.key,
        equivalent: (previous?.equivalent ?? 0) + state.acc.equivalent,
        buckets: addBuckets(previous?.buckets ?? ZERO_BUCKETS, state.acc.buckets),
        sessions: (previous?.sessions ?? 0) + 1,
        overhead: mergeOverhead(previous?.overhead ?? {}, state.overhead),
        updatedAt: new Date().toISOString(),
      }
      await writeJsonAtomic(this.recordPath(repo.key), next)
      this.repoCache.set(repo.key, next)
    } catch (error) {
      this.ctx.logger('dsh-te-cost').warn('repo totals not persisted: %s', String(error))
    }
  }
}

function readRoute(event: SessionEvent): { provider?: string; model?: string } | undefined {
  const data = event.data as {
    header?: { config?: { provider?: string; model?: string } }
    provider?: string
    model?: string
  }
  const fromHeader = data.header?.config
  if (fromHeader?.provider !== undefined) return { provider: fromHeader.provider, model: fromHeader.model }
  if (data.provider !== undefined) return { provider: data.provider, model: data.model }
  return undefined
}

function overheadTotal(overhead: Record<string, number>): number {
  let total = 0
  for (const value of Object.values(overhead)) total += value
  return total
}

function mergeOverhead(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = { ...left }
  for (const [key, value] of Object.entries(right)) merged[key] = (merged[key] ?? 0) + value
  return merged
}

function describeOverhead(overhead: Record<string, number>): string {
  const parts = Object.entries(overhead)
    .filter(([, value]) => value > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} ${formatTokens(value)}`)
  return parts.length === 0 ? '' : ` (${parts.join(' · ')})`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cache-weighted equivalent-token accounting; present while this component is mounted. */
    teCost: CostLedger
  }
}

/**
 * Mount the component on a DSH context.
 *
 * Disabled means absent: no service, no command, no listener.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  ctx.plugin(CostLedger, config)
}

export { bucketsTotal }
