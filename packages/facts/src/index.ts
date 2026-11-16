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
 * the first step of a session, and nothing at all when no fact qualifies.
 *
 * @module @gyk/dsh-te-facts
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  NEW_LIFECYCLE,
  confirm,
  contradict,
  contradicted,
  extractFacts,
  injectable,
  intentOf,
  readJson,
  recordExercise,
  repoKeyDirName,
  resolveRepoKey,
  score,
  stateRoot,
  wasteRecurred,
  writeJsonAtomic,
  type FactLifecycle,
  type ShellCall,
} from '@gyk/dsh-te-core'
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
  version: 1
  key: string
  /** Sessions that ended in this repository; the lifecycle clock. */
  tasks: number
  facts: StoredFact[]
}

/** What one live session has shown us so far. */
interface SessionWatch {
  calls: ShellCall[]
  /** Fact keys injected into this session, or undefined before the decision. */
  injected?: string[]
}

/** Text blocks of a tool result, in order. */
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

/** Render the injected block for a set of facts. */
function render(facts: readonly StoredFact[], maxChars: number): string | undefined {
  if (facts.length === 0 || maxChars <= 0) return undefined
  const header = 'Facts learned from earlier sessions in this repository (verify before relying):'
  const lines: string[] = [header]
  let used = header.length
  for (const fact of facts) {
    const line = `- ${fact.text}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 1 ? lines.join('\n') : undefined
}

/**
 * Per-repository fact store and per-session watcher.
 * Exposed on the context as `teFacts`.
 */
export class Facts extends Service {
  static inject = ['commands']

  private readonly watching = new Map<string, SessionWatch>()

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
      const message = await this.injectedMessage(payload.agent, payload.turn, payload.step)
      if (message === undefined) return decision
      return { kind: 'enter', messages: [...decision.messages, message] }
    })
    this.ctx.on('session/disposed', (session) => {
      this.settle(session).catch(() => {
        // A learning pass must never take the session down with it.
      })
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
    const stored = await readJson<RepoFacts>(repoFactsPath(key))
    const repo: RepoFacts =
      stored !== undefined && stored.version === 1 && Array.isArray(stored.facts)
        ? stored
        : { version: 1, key, tasks: 0, facts: [] }
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

  /** The user-role message to admit, or undefined to leave the step alone. */
  private async injectedMessage(agent: Agent, turn: number, step: number): Promise<ReturnType<typeof createUserMessage> | undefined> {
    if (turn !== 1 || step !== 1) return undefined
    const session = agent.session
    const watch = this.watchOf(session)
    if (watch.injected !== undefined) return undefined
    watch.injected = []
    const repo = await this.repoOf(session)
    const facts = this.worthInjecting(repo)
    const text = render(facts, this.config.maxChars)
    if (text === undefined) return undefined
    watch.injected = facts.map((fact) => fact.key)
    this.bill(session, text)
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-te-facts', form: 'facts' } as never,
    })
  }

  /** Count the injected text as this component's own overhead, when a ledger is present. */
  private bill(session: Session, text: string): void {
    const ledger = this.ctx.get('teCost') as { recordOverhead?: (target: Session, label: string, tokens: number) => void } | undefined
    ledger?.recordOverhead?.(session, 'facts', Math.ceil(text.length / 4))
  }

  /**
   * Fold a finished session into the repository's facts.
   * @param session - the session that just ended.
   */
  async settle(session: Session): Promise<void> {
    const watch = this.watching.get(session.id)
    this.watching.delete(session.id)
    const repo = await this.repoOf(session)
    const ordinal = repo.tasks + 1
    const calls = watch?.calls ?? []
    const learned = new Map(extractFacts(calls).map((candidate) => [candidate.key, candidate]))

    for (const fact of [...repo.facts]) {
      if (fact.state === 'retired') continue
      const exercised = calls.some((call) => intentOf(call.command) === fact.intent)
      const waste = wasteRecurred(calls, fact.key)
      let next: StoredFact = { ...fact, ...recordExercise(fact, exercised, waste) }
      if (contradicted(calls, fact.key)) {
        // The claim was false here: fail toward retirement, never toward
        // re-injection of something the repository has already disproved.
        next = { ...next, ...contradict(next, ordinal) }
      } else if (learned.has(fact.key) || waste) {
        next = { ...next, ...confirm(next, ordinal) }
      }
      this.replace(repo, next)
    }

    for (const candidate of learned.values()) {
      if (repo.facts.some((fact) => fact.key === candidate.key)) continue
      // The session that taught us the fact exercised it too: it saw both the
      // failure and the repair, so it is the first entry in the firing record.
      repo.facts.push({
        ...recordExercise(NEW_LIFECYCLE, true, true),
        ...candidate,
        confirms: [ordinal],
      })
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
        return `${fact.state.padEnd(9)} score ${score(fact, ordinal).toFixed(2).padStart(5)}  fired ${rate.padStart(4)}  ${fact.text}`
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
