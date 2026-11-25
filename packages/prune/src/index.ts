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
  /**
   * Off by default: hiding a tool changes the request prefix. Counters are
   * recorded either way, which is what makes the decision reversible.
   */
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
  // The external compressor's own tools, including the ones its feature flags
  // register later: hiding a tool the model was told to call leaves it reaching
  // for something that is not there. `acp_read_original_image` is the only way
  // back to the pixels that compressor downscaled.
  'acp_cache',
  'acp_read_original_image',
  'acp_restore',
  'acp_retire',
  'acp_retrieve',
  'acp_rewrite',
  'acp_rule',
  'acp_status',
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
/** What `/te` needs to say about this component. */
export interface PruneSummary {
  sessions: number
  tracked: number
  /** Idle long enough to hide, by recorded counters alone. */
  candidates: string[]
  hiddenNow: number
  idleSessions: number
}

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

/**
 * Rough token cost of a tool schema: the chars / 4 rule the rest of the suite
 * uses, because no tokenizer is reachable from the plugin host.
 */
function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4)
}

/** 1234 -> 1.2k. Exact numbers in a preview would claim precision there is none of. */
function shortTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
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
        description: 'Show the idle counters, preview or restore tool hiding',
        input: { hint: 'restore | dry-run' },
        handler: async (invocation) => {
          const session = invocation.agent.session
          // A resumed session may have no in-memory state yet; load it so the
          // command answers from disk instead of claiming nothing was measured.
          await this.repoOf(session)
          const raw = invocation.rawInput.trim().toLowerCase()
          if (raw === 'restore') {
            return { kind: 'success', text: await this.restore(session) }
          }
          if (raw === 'dry-run' || raw === '--dry-run') {
            return { kind: 'success', text: await this.preview(invocation.agent) }
          }
          return { kind: 'success', text: this.report(invocation.agent) }
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
    // Measuring is always on; only hiding is opt-in.
    if (!this.config.enabled) return
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

  /**
   * Counts for the bundle's `/te` overview.
   *
   * Candidates are computed from the recorded idle counters alone; whether a
   * tool is actually in the registry is checked at session start, so this can
   * name a tool the next session will not hide (for example one that was
   * uninstalled since it was last counted).
   */
  async snapshot(session: Session): Promise<PruneSummary> {
    const repo = await this.repoOf(session)
    const keep = this.protectedNames()
    const restored = new Set(repo.restored)
    const candidates = Object.entries(repo.tools)
      .filter(([tool, record]) => !keep.has(tool) && !restored.has(tool) && record.idle >= this.config.idleSessions)
      .sort((left, right) => right[1].idle - left[1].idle)
      .slice(0, this.config.maxHidden)
      .map(([tool]) => tool)
    return {
      sessions: repo.sessions,
      tracked: Object.keys(repo.tools).length,
      candidates,
      hiddenNow: this.watching.get(session.id)?.hidden.length ?? 0,
      idleSessions: this.config.idleSessions,
    }
  }

  /**
   * What the next session would hide, and roughly what that saves.
   *
   * Answers the question the counters exist for: is enabling this worth it? The
   * counters and the candidate list are exact; the token figures are chars / 4
   * estimates, and the last line says the part estimates cannot capture: the
   * first request after the set changes pays full price for the prefix.
   */
  async preview(agent: Agent): Promise<string> {
    const session = agent.session
    const key = resolveRepoKey(session.header?.cwd ?? process.cwd()).key
    const repo = await this.repoOf(session)
    const tools = agent.ctx.get('tools') as ToolsService | undefined
    const schemas = tools?.schemas() ?? []
    const available = schemas.map((schema) => schema.name)
    const deny = this.candidates(repo, available)
    const sizes = new Map(schemas.map((schema) => [schema.name, estimateTokens(schema)]))
    const total = schemas.reduce((sum, schema) => sum + estimateTokens(schema), 0)
    if (deny.length === 0) {
      return `Nothing would be hidden: no tool is idle for ${this.config.idleSessions} sessions in ${key} (${repo.sessions} recorded).`
    }
    const saved = deny.reduce((sum, tool) => sum + (sizes.get(tool) ?? 0), 0)
    const share = total === 0 ? 0 : Math.round((saved / total) * 100)
    const rows = deny.map((tool) => {
      const record = repo.tools[tool]
      const idle = record === undefined ? 0 : record.idle
      const uses = record === undefined ? 0 : record.uses
      return `${tool}  idle ${idle}/${this.config.idleSessions}  uses ${uses}  ~${shortTokens(sizes.get(tool) ?? 0)} tokens`
    })
    const head = `Dry run for ${key}: ${repo.sessions} sessions recorded, hides at ${this.config.idleSessions} idle`
    const line = `Would hide ${deny.length} of ${available.length} tools: ~${shortTokens(saved)} schema tokens per request (${share}% of the tool block).`
    const off = this.config.enabled
      ? 'This is what the next session will hide.'
      : 'Nothing is hidden until enabled: true; the counters keep accumulating either way.'
    const cost =
      'The first request after the set changes pays full price for the prompt prefix once; the saving starts after that request.'
    return [head, '', ...rows, '', line, off, cost].join('\n')
  }

  /**
   * Human-readable listing for `/te-prune`.
   *
   * The counters answer "what is idle"; the last line answers "what would that be
   * worth", which is the question the decision actually needs. Sizes are the same
   * chars/4 estimate the dry run uses, and the one-off cost of changing the tool
   * set stays in view so the saving is not read as free.
   */
  report(agent: Agent): string {
    const session = agent.session
    const key = resolveRepoKey(session.header?.cwd ?? process.cwd()).key
    const repo = this.repos.get(key)
    if (repo === undefined || repo.sessions === 0) return `Nothing measured yet for ${key}.`
    const watch = this.watching.get(session.id)
    const keep = this.protectedNames()
    const candidates = Object.entries(repo.tools).filter(([tool]) => !keep.has(tool))
    const schemas = (agent.ctx.get('tools') as ToolsService | undefined)?.schemas() ?? []
    const available = schemas.map((schema) => schema.name)
    const sizes = new Map(schemas.map((schema) => [schema.name, estimateTokens(schema)]))
    const total = schemas.reduce((sum, schema) => sum + estimateTokens(schema), 0)
    const deny = new Set(this.candidates(repo, available))
    // Width from the data: an MCP tool name is routinely longer than the 18 the
    // fixed header assumed, and a ragged table reads as broken output.
    const width = Math.max(18, ...candidates.map(([tool]) => tool.length))
    const rows = candidates
      .sort((left, right) => right[1].idle - left[1].idle)
      .map(([tool, record]) => {
        const state = repo.restored.includes(tool)
          ? 'kept'
          : record.idle >= this.config.idleSessions
            ? this.config.enabled
              ? 'hidden next session'
              : 'would hide'
            : 'visible'
        const size = deny.has(tool) ? `  ~${shortTokens(sizes.get(tool) ?? 0)} tokens` : ''
        return `${tool.padEnd(width)} idle ${String(record.idle).padStart(2)}/${this.config.idleSessions}  uses ${String(record.uses).padStart(3)}  ${state}${size}`
      })
    const head = `Pruning for ${key} (${repo.sessions} sessions, hides at ${this.config.idleSessions} idle)`
    const hidden = watch?.hidden.length ? `Hidden this session: ${watch.hidden.join(', ')}` : undefined
    const saved = [...deny].reduce((sum, tool) => sum + (sizes.get(tool) ?? 0), 0)
    const share = total === 0 ? 0 : Math.round((saved / total) * 100)
    const value =
      deny.size === 0
        ? 'Nothing is idle enough to hide yet; the counters keep accumulating.'
        : schemas.length === 0
          ? undefined
          : `Hiding ${deny.size} of ${available.length} tools saves ~${shortTokens(saved)} schema tokens per request (${share}% of the tool block). The first request after the set changes pays the prefix once.`
    return [head, hidden, ...rows, '', value].filter((line) => line !== undefined).join('\n')
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

/**
 * Mount the component.
 *
 * Mounted even when disabled: the counters are the only way to answer whether
 * enabling it is worth it, and `dry-run` is for the people who have not enabled
 * it yet. `enabled` decides whether a tool is hidden, not whether anything is
 * measured — a disabled prune still writes prune.json, which holds tool names
 * and counters and nothing else.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(Prune, config)
}
