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
 * @module dsh-te-prune
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, ToolsService } from '@deepseek-ai/dsh-tools'
import { readJson, repoKeyDirName, resolveRepoKey, stateRoot, writeJsonAtomic } from 'dsh-te-core'
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

/** Whether this session is a delegation of another one. */
function isSubagent(session: Session): boolean {
  return session.header?.origin === 'subagent'
}

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
  // Hiding these is self-defeating: they are how a long session stays cheap and
  // how an agent reaches the facts/skills it was told about.
  'compress',
  'decompress',
  'search_context',
  'skill',
  'read_image',
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

  /** Settles in flight, awaited by the `session/flush` durability checkpoint. */
  private readonly pending = new Map<string, Promise<void>>()

  private readonly repos = new Map<string, RepoPrune>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'tePrune')
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.on('tools/result', (exec, result) => {
      this.observe(exec, result)
    })
    // `agent/created` is after `agentCtx` exists and before the first prompt is
    // assembled. Doing this any later would send the first request with the full
    // tool block and then change it, which re-reads the whole prompt uncached.
    this.ctx.on('agent/created', async ({ agent }) => {
      if (isSubagent(agent.session)) return
      await this.maybeRestrict(agent)
    })
    this.ctx.on('session/disposed', (session) => {
      // Teardown does not await listeners; the write is drained by the awaited
      // `session/flush` checkpoint rather than racing the process exit.
      this.pending.set(
        session.id,
        this.settle(session)
          .catch((error: unknown) => {
            // Losing a pruning pass is harmless; never fail the session over it.
            this.ctx.logger('dsh-te-prune').warn('prune state not settled: %s', String(error))
          })
          .finally(() => this.pending.delete(session.id)),
      )
    })
    this.ctx.on('session/flush', async () => {
      await Promise.all([...this.pending.values()])
    })
    this.ctx.effect(() =>
      this.ctx.commands.register({
        name: 'te-prune',
        description: 'Show or restore tools hidden by dsh-te-prune',
        input: { hint: 'restore' },
        handler: async (invocation) => {
          const session = invocation.agent.session
          // A resumed session may have no in-memory state yet; load it so the
          // command answers from disk instead of claiming nothing was measured.
          await this.repoOf(session)
          const raw = invocation.rawInput.trim().toLowerCase()
          if (raw === 'restore') {
            return { kind: 'success', text: await this.restore(session) }
          }
          return { kind: 'success', text: this.report(session) }
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
  private async maybeRestrict(agent: Agent): Promise<void> {
    const session = agent.session
    const watch = this.watchOf(session)
    if (watch.decided) return
    watch.decided = true
    const repo = await this.repoOf(session)
    // The restriction must be installed on the agent's own scope: a
    // context-global one would mask the tool for every agent in the process,
    // and the registry rejects it outright.
    const tools = agent.ctx.get('tools') as ToolsService | undefined
    if (tools === undefined) return
    const available = tools.schemas().map((schema) => schema.name)
    const deny = this.candidates(repo, available)
    if (deny.length === 0) return
    try {
      watch.hidden = deny
      watch.dispose = tools.restrict({ deny })
    } catch (error) {
      // A name registered only for this agent, or one that disappeared between
      // listing and restricting, makes the whole filter invalid. Hiding tools is
      // an optimization: leave the set untouched rather than fail the session.
      watch.hidden = []
      this.ctx.logger('dsh-te-prune').warn('could not hide idle tools: %s', String(error))
    }
  }

  /**
   * Fold a finished session into the repository's idle counters.
   * @param session - the session that just ended.
   */
  async settle(session: Session): Promise<void> {
    // A subagent child is a delegation of the session that already counts: it
    // would otherwise age every tool it never had reason to call.
    if (isSubagent(session)) return
    const watch = this.watching.get(session.id)
    this.watching.delete(session.id)
    try {
      watch?.dispose?.()
    } catch {
      // The agent scope may already be torn down; the restriction died with it.
    }
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
    const repo = await this.repoOf(session)
    // The live mask must go too, or the tool stays hidden until this session ends
    // even though the command promises it back.
    const watch = this.watching.get(session.id)
    try {
      watch?.dispose?.()
    } catch {
      // The agent scope may already be gone; nothing left to release.
    }
    if (watch !== undefined) {
      watch.dispose = undefined
      watch.hidden = []
    }
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
