/**
 * Repository facts, learned mechanically and spent sparingly.
 *
 * The component watches shell calls in a session, and when a session dies it
 * turns "this form failed here, that form worked" into a fact. Facts are scoped
 * to one repository (git origin remote, else the working directory) and are
 * only injected once they have been confirmed by three separate sessions *and*
 * the waste they warn about is still happening. That second gate is the point:
 * a fact the model has already absorbed stops costing tokens.
 *
 * Injection rides the logged pre-step channel: one extra user-role message at
 * the first step of every turn, and nothing at all when no fact qualifies. The
 * turn boundary is what keeps it visible: a compressor can fold the previous
 * copy out of the request while this session still lists it.
 *
 * @module dsh-te-facts
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-te-facts': { kind: 'dsh-te-facts'; form: 'notice' }
  }
}
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  NEW_LIFECYCLE,
  confirm,
  contradict,
  contradicted,
  exercised,
  extractFacts,
  formatTokens,
  injectable,
  injectionSplit,
  readJson,
  recordExercise,
  recordInjection,
  repoKeyDirName,
  resolveRepoKey,
  score,
  stateRoot,
  wasteRecurred,
  wastedCalls,
  writeJsonAtomic,
  type FactLifecycle,
  type ShellCall,
} from 'dsh-te-core'
import { join } from 'node:path'

/** Settings for the facts component. */
export interface Config {
  /** Watch and inject. Off means the component does nothing at all. */
  enabled: boolean
  /** Never inject more than this many facts at once (TokenEconomizer used 4). */
  maxFacts: number
  /** Hard cap on the injected text; ~150 tokens at 4 chars/token. */
  maxChars: number
}

export const name = 'dsh-te-facts'

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxFacts: z.number().min(0).default(4),
  maxChars: z.number().min(0).default(600),
})

/** One stored fact: what it claims plus how it has fared. */
interface StoredFact extends FactLifecycle {
  readonly key: string
  readonly family: 'form-repair' | 'env-value'
  readonly intent: string
  readonly text: string
}

/** The learned state of one repository. */
interface RepoFacts {
  version: 2
  key: string
  /** Sessions that ended in this repository; the lifecycle clock. */
  tasks: number
  facts: StoredFact[]
}

/** One fact that was actually shown to the model, and what its line cost. */
interface InjectedFact {
  readonly key: string
  readonly tokens: number
}

/** What one live session has shown us so far. */
interface SessionWatch {
  calls: ShellCall[]
  /**
   * The facts of this session's most recent injection, or undefined before the
   * first one.
   *
   * The share of the injected text is carried here rather than written to the
   * store at injection time: the ordinal is only known at settle, and a hot
   * path should not add a write.
   */
  injected?: readonly InjectedFact[]
}

/** How many facts one repository may keep; lowest-value facts go first. */
const FACT_CAP = 200

/**
 * Whether one stored entry still has the shape this version understands.
 *
 * A hand-edited, truncated or older file must degrade to "that entry is gone",
 * not to a throw on the step-1 hot path.
 */
function isStoredFact(value: unknown): value is StoredFact {
  if (value === null || typeof value !== 'object') return false
  const fact = value as Partial<StoredFact>
  return (
    typeof fact.key === 'string' &&
    typeof fact.text === 'string' &&
    (fact.family === 'form-repair' || fact.family === 'env-value') &&
    (fact.state === 'candidate' || fact.state === 'active' || fact.state === 'retired') &&
    Array.isArray(fact.confirms) &&
    Array.isArray(fact.contradicts) &&
    typeof fact.fired === 'number' &&
    typeof fact.firedWaste === 'number'
  )
}

/** Fill the bookkeeping a pre-0.2.0 record does not carry. */
function withHistory(fact: StoredFact): StoredFact {
  return {
    ...fact,
    injectedTasks: Array.isArray(fact.injectedTasks) ? fact.injectedTasks : [],
    exercisedTasks: Array.isArray(fact.exercisedTasks) ? fact.exercisedTasks : [],
    wastedTasks: Array.isArray(fact.wastedTasks) ? fact.wastedTasks : [],
    injectedTokens: typeof fact.injectedTokens === 'number' ? fact.injectedTokens : 0,
    wasteTokens: typeof fact.wasteTokens === 'number' ? fact.wasteTokens : 0,
  }
}

/** Whether this session is a subagent child rather than a top-level task. */
function isSubagent(session: Session): boolean {
  return session.header?.origin === 'subagent'
}

/** Equivalent tokens for a piece of injected or failed output, at 4 chars each. */
function tokensOf(text: string): number {
  return Math.ceil(text.length / 4)
}

function textOf(result: ToolExecutionResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

/** Trim output to what the extractors actually read. */
function relevant(output: string): string {
  return output.length <= 4_000 ? output : `${output.slice(0, 2_000)}\n${output.slice(-2_000)}`
}

/** The shell command a tool call carried, when it carried one. */
function commandOf(exec: ToolExecution): string | undefined {
  if (exec.name !== 'bash' && exec.name !== 'bash_persistent') return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

/** Where one repository's facts live. */
function repoFactsPath(key: string): string {
  return join(stateRoot(), 'repos', repoKeyDirName(key), 'facts.json')
}

/** A rendered block plus what each of its lines costs. */
interface Rendered {
  readonly text: string
  readonly headerTokens: number
  readonly perFact: readonly InjectedFact[]
}

/**
 * Render the injected block for a set of facts.
 *
 * Per-line tokens are returned alongside the text so the same number can be
 * billed to the ledger and stored against the fact. They are counted per line
 * rather than by sharing out the whole string, which is why the ledger bills
 * the header separately: the two sums then agree exactly instead of "almost".
 */
function render(facts: readonly StoredFact[], maxChars: number): Rendered | undefined {
  if (facts.length === 0 || maxChars <= 0) return undefined
  const header = 'Facts learned from earlier sessions in this repository (verify before relying):'
  const lines: string[] = [header]
  const perFact: InjectedFact[] = []
  let used = header.length
  for (const fact of facts) {
    const line = `- ${fact.text}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    perFact.push({ key: fact.key, tokens: tokensOf(line) })
    used += line.length + 1
  }
  if (lines.length === 1) return undefined
  return { text: lines.join('\n'), headerTokens: tokensOf(header), perFact }
}

/**
 * Whether a message is exactly the notice we would inject.
 *
 * Only the tail is checked: there a duplicate is provably still visible to the
 * model, which is the one case where skipping it saves tokens instead of losing
 * the facts to a fold further back.
 */
function lastNoticeIs(messages: readonly UserMessage[], text: string): boolean {
  const last = messages[messages.length - 1]
  if (last === undefined || last.source.kind !== 'dsh-te-facts') return false
  return last.content.map((block) => (block.type === 'text' ? block.text : '')).join('') === text
}

/**
 * Per-repository fact store and per-session watcher.
 * Exposed on the context as `teFacts`.
 */
export class Facts extends Service {
  static inject = ['commands']

  private readonly watching = new Map<string, SessionWatch>()

  /** Settles in flight, awaited by the `session/flush` durability checkpoint. */
  private readonly pending = new Map<string, Promise<void>>()

  private readonly repos = new Map<string, RepoFacts>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'teFacts')
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.on('tools/result', (exec, result) => {
      this.observe(exec, result)
    })
    this.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      if (isSubagent(payload.agent.session)) return decision
      let message: ReturnType<typeof createUserMessage> | undefined
      try {
        message = await this.injectedMessage(payload.agent, payload.step, decision.messages)
      } catch (error) {
        // Injection is an optimization: a damaged state file must never stop a
        // session from starting.
        this.ctx.logger('dsh-te-facts').warn('facts not injected: %s', String(error))
        return decision
      }
      if (message === undefined) return decision
      // Spread the decision: it may carry `startsRequestSeries`, and dropping it
      // would move the prefix-cache boundary for every listener after us.
      return { ...decision, messages: [...decision.messages, message] }
    })
    this.ctx.on('session/disposed', (session) => {
      // Teardown does not await listeners, so the write is drained by the
      // awaited `session/flush` checkpoint instead of racing the process exit.
      this.pending.set(
        session.id,
        this.settle(session)
          .catch((error: unknown) => {
            // A learning pass must never take the session down with it.
            this.ctx.logger('dsh-te-facts').warn('facts not settled: %s', String(error))
          })
          .finally(() => this.pending.delete(session.id)),
      )
    })
    this.ctx.on('session/flush', async () => {
      await Promise.all([...this.pending.values()])
    })
    this.ctx.effect(() =>
      this.ctx.commands.register({
        name: 'te-facts',
        description: 'List repository facts learned by dsh-te-facts',
        handler: (invocation) => ({ kind: 'success', text: this.report(invocation.agent.session) }),
      }),
    )
  }

  /** Record one shell call. */
  private observe(exec: ToolExecution, result: ToolExecutionResult): void {
    const session = exec.agent?.session
    const command = commandOf(exec)
    if (session === undefined || command === undefined) return
    const watch = this.watchOf(session)
    if (watch.calls.length >= 200) watch.calls.shift()
    watch.calls.push({ command, ok: result.isError !== true, output: relevant(textOf(result)) })
  }

  /** The watcher for one session. */
  private watchOf(session: Session): SessionWatch {
    const existing = this.watching.get(session.id)
    if (existing !== undefined) return existing
    const created: SessionWatch = { calls: [] }
    this.watching.set(session.id, created)
    return created
  }

  /** Load (and cache) the facts of the session's repository. */
  private async repoOf(session: Session): Promise<RepoFacts> {
    const key = resolveRepoKey(session.header?.cwd ?? process.cwd()).key
    const cached = this.repos.get(key)
    if (cached !== undefined) return cached
    const stored = await readJson<{ version?: number; tasks?: number; facts?: unknown[] }>(repoFactsPath(key))
    // v1 is readable: the fields this version adds are filled in place rather
    // than the whole repository being thrown away.
    const readable = stored !== undefined && (stored.version === 1 || stored.version === 2) && Array.isArray(stored.facts)
    const repo: RepoFacts = {
      version: 2,
      key,
      tasks: readable && typeof stored.tasks === 'number' ? stored.tasks : 0,
      facts: readable ? (stored?.facts ?? []).filter(isStoredFact).map(withHistory) : [],
    }
    this.repos.set(key, repo)
    return repo
  }

  /** Facts worth injecting now, best first. */
  private worthInjecting(repo: RepoFacts): StoredFact[] {
    const ordinal = repo.tasks
    return repo.facts
      .filter((fact) => injectable(fact, ordinal))
      .sort((left, right) => score(right, ordinal) - score(left, ordinal))
      .slice(0, this.config.maxFacts)
  }

  /**
   * The user-role message to admit, or undefined to leave the step alone.
   *
   * The block is re-admitted at the first step of every turn. A compressor folds
   * older history on the wire, so the copy this session still lists is usually
   * not in the request the model is about to answer; re-admitting it at the turn
   * boundary is what keeps the facts inside the protected tail.
   */
  private async injectedMessage(agent: Agent, step: number, messages: readonly UserMessage[]): Promise<ReturnType<typeof createUserMessage> | undefined> {
    // One injection per step: the later steps of a turn already follow its notice.
    if (step !== 1) return undefined
    const session = agent.session
    const repo = await this.repoOf(session)
    const rendered = render(this.worthInjecting(repo), this.config.maxChars)
    if (rendered === undefined) return undefined
    // A notice that is already the last message has nothing after it, so it is
    // still inside any compressor's tail window: repeating it would spend the
    // same tokens twice for no new visibility.
    if (lastNoticeIs(messages, rendered.text)) return undefined
    const watch = this.watchOf(session)
    watch.injected = rendered.perFact
    this.bill(session, rendered)
    return createUserMessage({
      content: [{ type: 'text', text: rendered.text }],
      source: { kind: 'dsh-te-facts', form: 'notice' },
    })
  }

  /** Count the injected text as this component's own overhead, when a ledger is present. */
  private bill(session: Session, rendered: Rendered): void {
    const ledger = this.ctx.get('teCost') as { recordOverhead?: (target: Session, label: string, tokens: number) => void } | undefined
    let total = rendered.headerTokens
    for (const fact of rendered.perFact) total += fact.tokens
    ledger?.recordOverhead?.(session, 'facts', total)
  }

  /**
   * Fold a finished session into the repository's facts.
   * @param session - the session that just ended.
   */
  async settle(session: Session): Promise<void> {
    const watch = this.watching.get(session.id)
    this.watching.delete(session.id)
    // A subagent child is a delegation of the session that already counts:
    // folding it in would inflate the task ordinal that promotions are keyed on.
    if (isSubagent(session)) return
    const repo = await this.repoOf(session)
    const ordinal = repo.tasks + 1
    const calls = watch?.calls ?? []
    const learned = new Map(extractFacts(calls).map((candidate) => [candidate.key, candidate]))

    for (const fact of [...repo.facts]) {
      if (fact.state === 'retired') continue
      const arose = exercised(calls, fact.key)
      // The same calls answer both questions: whether the waste happened, and
      // what it cost. Pricing it here is what makes a later payback sum real.
      const wasted = wastedCalls(calls, fact.key)
      const waste = wasteRecurred(calls, fact.key)
      const wasteTokens = wasted.reduce((total, call) => total + tokensOf(call.output), 0)
      let next: StoredFact = { ...fact, ...recordExercise(fact, ordinal, arose, waste, wasteTokens) }
      if (contradicted(calls, fact.key)) {
        // The claim was false here: fail toward retirement, never toward
        // re-injection of something the repository has already disproved.
        next = { ...next, ...contradict(next, ordinal) }
      } else if (learned.has(fact.key) || waste) {
        next = { ...next, ...confirm(next, ordinal) }
      }
      this.replace(repo, next)
    }

    // The injections this session actually made are booked here, where its
    // ordinal is known, rather than guessed at injection time.
    for (const injected of watch?.injected ?? []) {
      const fact = repo.facts.find((candidate) => candidate.key === injected.key)
      if (fact === undefined) continue
      this.replace(repo, { ...fact, ...recordInjection(fact, ordinal, injected.tokens) })
    }

    for (const candidate of learned.values()) {
      const known = repo.facts.find((fact) => fact.key === candidate.key)
      if (known !== undefined && known.state !== 'retired') continue
      if (known !== undefined) {
        // Retired is not permanent: a repository can change (tooling added, env
        // fixed, then broken again). Re-learn from scratch rather than resurrect
        // the old record, so the promotion and firing evidence starts clean.
        repo.facts.splice(repo.facts.indexOf(known), 1)
      }
      // The session that taught us the fact exercised it too: it saw both the
      // failure and the repair, so it is the first entry in the firing record.
      const wasted = wastedCalls(calls, candidate.key)
      repo.facts.push({
        ...recordExercise(
          NEW_LIFECYCLE,
          ordinal,
          true,
          true,
          wasted.reduce((total, call) => total + tokensOf(call.output), 0),
        ),
        ...candidate,
        confirms: [ordinal],
      })
    }

    if (repo.facts.length > FACT_CAP) {
      // Keep what is provably useful longest: retired entries go first, then the
      // lowest-scoring candidates.
      const ranked = [...repo.facts].sort((left, right) => {
        const retiredLeft = left.state === 'retired' ? 0 : 1
        const retiredRight = right.state === 'retired' ? 0 : 1
        if (retiredLeft !== retiredRight) return retiredLeft - retiredRight
        return score(left, ordinal) - score(right, ordinal)
      })
      repo.facts = ranked.slice(ranked.length - FACT_CAP)
    }

    repo.tasks = ordinal
    this.repos.set(repo.key, repo)
    await writeJsonAtomic(repoFactsPath(repo.key), repo)
  }

  /** Replace one fact in place. */
  private replace(repo: RepoFacts, fact: StoredFact): void {
    const index = repo.facts.findIndex((entry) => entry.key === fact.key)
    if (index >= 0) repo.facts[index] = fact
  }

  /** Human-readable listing for `/te-facts`. */
  report(session: Session): string {
    const key = resolveRepoKey(session.header?.cwd ?? process.cwd()).key
    const repo = this.repos.get(key)
    if (repo === undefined) return `No facts learned yet for ${key}.`
    if (repo.facts.length === 0) return `No facts learned yet for ${key} (${repo.tasks} sessions).`
    const ordinal = repo.tasks
    const lines = repo.facts
      .slice()
      .sort((left, right) => score(right, ordinal) - score(left, ordinal))
      .map((fact) => {
        const rate = fact.fired === 0 ? '—' : `${Math.round((fact.firedWaste / fact.fired) * 100)}%`
        const split = injectionSplit(fact)
        // Only facts that were shown carry a spend; a candidate that has never
        // been injected says nothing rather than printing a row of zeros.
        const spend =
          split.injectedTasks === 0
            ? ''
            : `  inj ${split.injectedTasks}/${formatTokens(split.injectedTokens)}eq  after ${split.after.waste}/${split.after.tasks}`
        return `${fact.state.padEnd(9)} score ${score(fact, ordinal).toFixed(2).padStart(5)}  fired ${rate.padStart(4)}${spend}  ${fact.text}`
      })
    return [`Facts for ${key} (${repo.tasks} sessions)`, ...lines].join('\n')
  }

  /** Whether any session is currently being watched (used by tests). */
  get watchingCount(): number {
    return this.watching.size
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    teFacts: Facts
  }
}

/** Mount the component. */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  ctx.plugin(Facts, config)
}
