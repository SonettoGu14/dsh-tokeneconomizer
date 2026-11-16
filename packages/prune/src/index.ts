/**
 * Tool pruning: stop paying for tools a repository has never used.
 *
 * Every tool definition is re-sent on every request, so an unused tool is a
 * standing tax on the prompt. This component counts, per repository, how many
 * sessions have ended without a given tool being called; once a tool has been
 * idle for enough sessions it is hidden through the registry's own scoped
 * restriction — never by editing anyone's settings — and one command gives it
 * back for good.
 *
 * Why the decision is made once, at session start: the tool set is part of the
 * cached request prefix, so changing it mid-session throws away the cache. A
 * stable set per session costs nothing; a set that shifts per step costs a lot.
 *
 * @module @gyk/dsh-te-prune
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, ToolsService } from '@deepseek-ai/dsh-tools'
import { readJson, repoKeyDirName, resolveRepoKey, stateRoot, writeJsonAtomic } from '@gyk/dsh-te-core'
import { join } from 'node:path'

/** Settings for the pruning component. */
export interface Config {
  /** Off by default: hiding a tool changes the request prefix. */
  enabled: boolean
  /** Sessions a tool may stay idle before it becomes a candidate. */
  idleSessions: number
  /** Never hide more than this many tools in one session. */
  maxHidden: number
  /** Tool names that are never hidden, whatever their usage. */
  protected: string[]
}

export const name = 'dsh-te-prune'

/** Tools whose meaning is the session itself: hiding them breaks the harness. */
const ALWAYS_PROTECTED: readonly string[] = [
  'bash',
  'bash_persistent',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'todo_write',
  'ask_user_question',
  'working_directory',
  'job_output',
  'job_kill',
  'job_list',
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'wait_agent',
  'present',
]

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  idleSessions: z.number().min(1).default(5),
  maxHidden: z.number().min(0).default(8),
  protected: z.array(z.string()).default([]),
})

/** One tool's history in one repository. */
interface ToolRecord {
  /** Consecutive sessions that ended without calling it. */
  idle: number
  /** Sessions since the repository was first observed. */
  lastUsed: number
  uses: number
}

/** Per-repository pruning state. */
interface RepoPrune {
  version: 1
  key: string
  /** Sessions observed in this repository. */
  sessions: number
  tools: Record<string, ToolRecord>
  /** Tools the user asked to keep forever. */
  restored: string[]
}

/** What one live session has used. */
interface SessionWatch {
  used: Set<string>
  /** Tools hidden for this session, with the disposer that unhides them. */
  hidden: string[]
  dispose?: () => void
  decided: boolean
}

/** Tool names visible from the registry, when the service is present. */
function visibleTools(ctx: Context): string[] {
  const tools = ctx.get('tools') as ToolsService | undefined
  if (tools === undefined) return []
  return tools.schemas().map((schema) => schema.name)
}

/** Where one repository's pruning state lives. */
function repoPrunePath(key: string): string {
  return join(stateRoot(), 'repos', repoKeyDirName(key), 'prune.json')
}

/**
 * Per-repository pruning state and per-session application.
 * Exposed on the context as `tePrune`.
 */
export class Prune extends Service {
  static inject = ['commands']

  private readonly watching = new Map<string, SessionWatch>()

  private readonly repos = new Map<string, RepoPrune>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'tePrune')
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.on('tools/result', (exec, result) => {
      this.observe(exec, result)
    })
    this.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      await this.maybeRestrict(payload.agent, payload.turn, payload.step)
      return decision
    })
    this.ctx.on('session/disposed', (session) => {
      this.settle(session).catch(() => {
        // Losing a pruning pass is harmless; never fail the session over it.
      })
    })
    this.ctx.effect(() =>
      this.ctx.commands.register({
        name: 'te-prune',
        description: 'Show or restore tools hidden by dsh-te-prune',
        input: { hint: 'restore' },
        handler: async (invocation) => {
          const raw = invocation.rawInput.trim().toLowerCase()
          if (raw === 'restore') {
            return { kind: 'success', text: await this.restore(invocation.agent.session) }
          }
          return { kind: 'success', text: this.report(invocation.agent.session) }
        },
      }),
    )
  }

  /** Note that a tool ran. */
  private observe(exec: ToolExecution, _result: ToolExecutionResult): void {
    const session = exec.agent?.session
    if (session === undefined) return
    this.watchOf(session).used.add(exec.name)
  }

  /** The watcher for one session. */
  private watchOf(session: Session): SessionWatch {
    const existing = this.watching.get(session.id)
    if (existing !== undefined) return existing
    const created: SessionWatch = { used: new Set(), hidden: [], decided: false }
    this.watching.set(session.id, created)
    return created
  }

  /** Load (and cache) the pruning state of the session's repository. */
  private async repoOf(session: Session): Promise<RepoPrune> {
    const key = resolveRepoKey(session.header?.cwd ?? process.cwd()).key
    const cached = this.repos.get(key)
    if (cached !== undefined) return cached
    const stored = await readJson<RepoPrune>(repoPrunePath(key))
    const repo: RepoPrune =
      stored !== undefined && stored.version === 1 && typeof stored.tools === 'object'
        ? stored
        : { version: 1, key, sessions: 0, tools: {}, restored: [] }
    if (!Array.isArray(repo.restored)) repo.restored = []
    this.repos.set(key, repo)
    return repo
  }

  /** Names this component must never hide. */
  private protectedNames(): Set<string> {
    return new Set([...ALWAYS_PROTECTED, ...this.config.protected])
  }

  /** Candidates: idle long enough, not protected, not restored, visible right now. */
  private candidates(repo: RepoPrune, available: readonly string[]): string[] {
    const keep = this.protectedNames()
    const restored = new Set(repo.restored)
    return available
      .filter((tool) => !keep.has(tool) && !restored.has(tool))
      .filter((tool) => {
        const record = repo.tools[tool]
        return record !== undefined && record.idle >= this.config.idleSessions
      })
      .sort((left, right) => {
        const a = repo.tools[left]
        const b = repo.tools[right]
        if (a === undefined || b === undefined) return 0
        return b.idle - a.idle
      })
      .slice(0, this.config.maxHidden)
  }

  /** Hide this session's candidates, once, before the tools are assembled. */
  private async maybeRestrict(agent: Agent, turn: number, step: number): Promise<void> {
    if (turn !== 1 || step !== 1) return
    const session = agent.session
    const watch = this.watchOf(session)
    if (watch.decided) return
    watch.decided = true
    const repo = await this.repoOf(session)
    const available = visibleTools(this.ctx)
    const deny = this.candidates(repo, available)
    if (deny.length === 0) return
    const tools = this.ctx.get('tools') as ToolsService | undefined
    if (tools === undefined) return
    watch.hidden = deny
    watch.dispose = tools.restrict({ deny })
  }

  /**
   * Fold a finished session into the repository's idle counters.
   * @param session - the session that just ended.
   */
  async settle(session: Session): Promise<void> {
    const watch = this.watching.get(session.id)
    this.watching.delete(session.id)
    watch?.dispose?.()
    const repo = await this.repoOf(session)
    const ordinal = repo.sessions + 1
    const available = visibleTools(this.ctx)
    const seen = new Set([...available, ...watch?.used ?? [], ...this.protectedNames()])

    for (const tool of seen) {
      const record = repo.tools[tool] ?? { idle: 0, lastUsed: 0, uses: 0 }
      const used = watch?.used.has(tool) === true
      repo.tools[tool] = {
        idle: used ? 0 : record.idle + 1,
        lastUsed: used ? ordinal : record.lastUsed,
        uses: record.uses + (used ? 1 : 0),
      }
    }

    repo.sessions = ordinal
    this.repos.set(repo.key, repo)
    await writeJsonAtomic(repoPrunePath(repo.key), repo)
  }

  /** Give every hidden tool back, permanently. */
  async restore(session: Session): Promise<string> {
    const key = resolveRepoKey(session.header?.cwd ?? process.cwd()).key
    const repo = this.repos.get(key)
    if (repo === undefined) return `Nothing pruned in ${key}.`
    const hidden = Object.entries(repo.tools)
      .filter(([tool, record]) => !this.protectedNames().has(tool) && record.idle >= this.config.idleSessions)
      .map(([tool]) => tool)
    repo.restored = [...new Set([...repo.restored, ...hidden])]
    for (const tool of hidden) {
      const record = repo.tools[tool]
      if (record !== undefined) record.idle = 0
    }
    await writeJsonAtomic(repoPrunePath(key), repo)
    return hidden.length === 0
      ? `Nothing pruned in ${key}.`
      : `Restored ${hidden.join(', ')} — they will never be hidden again.`
  }

  /** Human-readable listing for `/te-prune`. */
  report(session: Session): string {
    const key = resolveRepoKey(session.header?.cwd ?? process.cwd()).key
    const repo = this.repos.get(key)
    if (repo === undefined || repo.sessions === 0) return `Nothing measured yet for ${key}.`
    const watch = this.watching.get(session.id)
    const keep = this.protectedNames()
    const rows = Object.entries(repo.tools)
      .filter(([tool]) => !keep.has(tool))
      .sort((left, right) => right[1].idle - left[1].idle)
      .map(([tool, record]) => {
        const state = repo.restored.includes(tool)
          ? 'kept'
          : record.idle >= this.config.idleSessions
            ? 'hidden next session'
            : 'visible'
        return `${tool.padEnd(18)} idle ${String(record.idle).padStart(2)}/${this.config.idleSessions}  uses ${String(record.uses).padStart(3)}  ${state}`
      })
    const head = `Pruning for ${key} (${repo.sessions} sessions, hides at ${this.config.idleSessions} idle)`
    const hidden = watch?.hidden.length ? `Hidden this session: ${watch.hidden.join(', ')}` : undefined
    return [head, hidden, ...rows].filter((line) => line !== undefined).join('\n')
  }

  /** Whether any session is currently being watched (used by tests). */
  get watchingCount(): number {
    return this.watching.size
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tePrune: Prune
  }
}

/** Mount the component. */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  ctx.plugin(Prune, config)
}
