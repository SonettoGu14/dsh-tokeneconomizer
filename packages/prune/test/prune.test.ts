import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { repoKeyDirName, resolveRepoKey, stateRoot } from 'dsh-te-core'
import { apply, Config } from '../src/index.ts'

const AVAILABLE = [
  'bash',
  'read',
  'web_search',
  'web_fetch',
  'mcp__zotero__search',
  'acp_cache',
  'acp_read_original_image',
  'acp_restore',
  'acp_retire',
  'acp_retrieve',
  'acp_rewrite',
  'acp_rule',
  'acp_status',
]

let home: string
let repo: string
let savedHome: string | undefined
let restricted: { deny?: readonly string[] }[]
let lifted: number
let commandHandler: ((invocation: unknown) => Promise<{ text: string }>) | undefined
let toolsStub: unknown

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-te-prune-'))
  repo = await mkdtemp(join(tmpdir(), 'dsh-te-repo-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  restricted = []
  lifted = 0
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  await rm(home, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

/** A session belonging to the throwaway repository. */
function sessionOf(id: string): Session {
  return { id, header: { cwd: repo } } as unknown as Session
}

/**
 * An agent whose `ctx` resolves services the way the real agent scope does.
 * `tools.restrict` only exists on an agent scope, so the plugin must not reach
 * for the plugin's own context here.
 */
function agentOf(target: Session, tools: unknown): { session: Session; ctx: { get: (name: string) => unknown } } {
  return { session: target, ctx: { get: (name: string) => (name === 'tools' ? tools : undefined) } }
}

/** Mount the component with stub command and tool services. */
async function mount(config: Partial<Config> = {}) {
  const ctx = new Context()
  ctx.provide('commands', {
    register: (command: { handler: typeof commandHandler }) => {
      commandHandler = command.handler
      return () => {}
    },
  } as never)
  ctx.provide('tools', {
    schemas: () => AVAILABLE.map((name) => ({ name })),
    restrict: (filter: { deny?: readonly string[] }) => {
      restricted.push(filter)
      return () => {
        lifted += 1
      }
    },
  } as never)
  toolsStub = ctx.get('tools')
  apply(ctx, { enabled: true, idleSessions: 3, maxHidden: 8, protected: [], ...config })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return ctx
}

/** Feed one tool call through the tools/result channel. */
function used(ctx: Context, session: Session, tool: string): void {
  ctx.emit(
    'tools/result',
    { name: tool, arguments: {}, agent: agentOf(session, toolsStub) } as never,
    { isError: false, content: [] } as never,
  )
}

/** One session that used `tools` and then ended. */
async function session(ctx: Context, id: string, tools: string[] = ['bash']): Promise<void> {
  const target = sessionOf(id)
  for (const tool of tools) used(ctx, target, tool)
  await ctx.tePrune.settle(target)
}

/**
 * Announce a new agent, which is when the real harness first has a scoped
 * context and has not yet assembled the first prompt.
 */
async function created(ctx: Context, agent: unknown): Promise<void> {
  const dispatch = ctx as unknown as { serial: (...args: unknown[]) => Promise<unknown> }
  await dispatch.serial('agent/created', { agent, source: 'start' })
}

/** Create a fresh agent for one session through the real event path. */
async function createAgent(ctx: Context, session: Session): Promise<void> {
  await created(ctx, agentOf(session, toolsStub))
}

/** Read the persisted pruning state. */
async function stored(): Promise<{ sessions: number; tools: Record<string, { idle: number; uses: number }> }> {
  const key = resolveRepoKey(repo).key
  return JSON.parse(await readFile(join(stateRoot(), 'repos', repoKeyDirName(key), 'prune.json'), 'utf8')) as never
}

describe('mounting', () => {
  it('measures without hiding when disabled', async () => {
    const ctx = await mount({ enabled: false })
    expect(ctx.tePrune).toBeDefined()
    await session(ctx, 's1', ['bash'])
    const state = await stored()
    expect(state.tools['web_search']?.idle).toBe(1)
    expect(restricted).toEqual([])
  })
})

describe('dry run', () => {
  it('previews the candidates without hiding anything', async () => {
    const ctx = await mount({ enabled: false, idleSessions: 1 })
    await session(ctx, 's1', ['bash'])
    const text = await ctx.tePrune.preview(agentOf(sessionOf('s2'), toolsStub) as never)
    expect(text).toContain('web_search')
    expect(text).toContain('Nothing is hidden until')
    expect(text).toContain('schema tokens per request')
    expect(restricted).toEqual([])
  })

  it('says so when nothing would be hidden', async () => {
    const ctx = await mount({ enabled: false, idleSessions: 5 })
    await session(ctx, 's1', ['bash'])
    const text = await ctx.tePrune.preview(agentOf(sessionOf('s2'), toolsStub) as never)
    expect(text).toContain('Nothing would be hidden')
  })

  it('answers the dry-run argument', async () => {
    const ctx = await mount({ idleSessions: 1 })
    await session(ctx, 's1', ['bash'])
    const result = await commandHandler!({
      agent: agentOf(sessionOf('s2'), toolsStub),
      rawInput: 'dry-run',
    } as never)
    expect(result.text).toContain('web_search')
    expect(restricted).toEqual([])
  })
})

describe('idle accounting', () => {
  it('counts a session without the tool as one idle session', async () => {
    const ctx = await mount()
    await session(ctx, 's1', ['bash'])
    const state = await stored()
    expect(state.tools['web_search']?.idle).toBe(1)
    expect(state.tools['bash']?.idle).toBe(0)
  })

  it('resets idle when the tool is used', async () => {
    const ctx = await mount()
    await session(ctx, 's1', ['bash'])
    await session(ctx, 's2', ['bash', 'web_search'])
    const state = await stored()
    expect(state.tools['web_search']?.idle).toBe(0)
    expect(state.tools['web_search']?.uses).toBe(1)
  })
})

describe('hiding', () => {
  it('hides nothing before the idle threshold', async () => {
    const ctx = await mount({ idleSessions: 3 })
    await session(ctx, 's1')
    await session(ctx, 's2')
    await createAgent(ctx, sessionOf('s3'))
    expect(restricted).toEqual([])
  })

  it('hides an idle tool once the threshold is reached', async () => {
    const ctx = await mount({ idleSessions: 3 })
    for (const id of ['s1', 's2', 's3']) await session(ctx, id)
    await createAgent(ctx, sessionOf('s4'))
    expect(restricted).toHaveLength(1)
    expect(restricted[0]?.deny).toContain('web_search')
    expect(restricted[0]?.deny).toContain('web_fetch')
  })

  it('never hides the harness basics', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id, [])
    await createAgent(ctx, sessionOf('s3'))
    expect(restricted[0]?.deny).not.toContain('bash')
    expect(restricted[0]?.deny).not.toContain('read')
  })

  it('never hides the external compressor tools', async () => {
    // The model is told these exist by that compressor's own prompt sections;
    // hiding them would leave it calling a tool that is no longer there.
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id, [])
    await createAgent(ctx, sessionOf('s3'))
    expect(restricted[0]?.deny).toContain('web_search')
    for (const name of [
      'acp_cache',
      'acp_read_original_image',
      'acp_restore',
      'acp_retire',
      'acp_retrieve',
      'acp_rewrite',
      'acp_rule',
      'acp_status',
    ]) {
      expect(restricted[0]?.deny).not.toContain(name)
    }
  })

  it('hides at most maxHidden tools', async () => {
    const ctx = await mount({ idleSessions: 2, maxHidden: 1 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    await createAgent(ctx, sessionOf('s3'))
    expect(restricted[0]?.deny).toHaveLength(1)
  })

  it('decides once per session, not on every step', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    const live = sessionOf('s3')
    await createAgent(ctx, live)
    await createAgent(ctx, live)
    expect(restricted).toHaveLength(1)
  })

  it('lifts the restriction when the session ends', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    const live = sessionOf('s3')
    await createAgent(ctx, live)
    await ctx.tePrune.settle(live)
    expect(lifted).toBe(1)
  })
})

describe('restore', () => {
  it('keeps a restored tool visible forever', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    expect(await ctx.tePrune.restore(sessionOf('s3'))).toContain('web_search')
    await session(ctx, 's3')
    await createAgent(ctx, sessionOf('s4'))
    expect(restricted).toEqual([])
  })
})


describe('session lifecycle', () => {
  it('ages the counters from the disposed event, not only from a direct settle call', async () => {
    const ctx = await mount({ idleSessions: 3 })
    const session = sessionOf('s1')
    used(ctx, session, 'bash')
    ctx.emit('session/disposed', session)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const state = await stored()
    expect(state.tools['web_search']?.idle).toBe(1)
    expect(state.tools['bash']?.idle).toBe(0)
  })
})

describe('scope discipline', () => {
  it('restricts through the agent scope, never the plugin context', async () => {
    const ctx = await mount({ idleSessions: 2 })
    // The registry rejects a context-global restriction outright; make the
    // global stub behave the same so reaching for `this.ctx` would fail loudly.
    const global = ctx.get('tools') as { restrict: (filter: unknown) => () => void }
    global.restrict = () => {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
    }
    toolsStub = {
      schemas: () => AVAILABLE.map((name) => ({ name })),
      restrict: (filter: { deny?: readonly string[] }) => {
        restricted.push(filter)
        return () => {
          lifted += 1
        }
      },
    }
    for (const id of ['s1', 's2']) await session(ctx, id)
    await createAgent(ctx, sessionOf('s3'))
    expect(restricted).toHaveLength(1)
  })

  it('leaves the tool set alone when the registry rejects the filter', async () => {
    const ctx = await mount({ idleSessions: 2 })
    toolsStub = {
      schemas: () => AVAILABLE.map((name) => ({ name })),
      restrict: () => {
        throw new Error('names unknown global tool "web_search"')
      },
    }
    for (const id of ['s1', 's2']) await session(ctx, id)
    await expect(createAgent(ctx, sessionOf('s3'))).resolves.toBeUndefined()
    expect(restricted).toEqual([])
  })
})

describe('restore permanence', () => {
  it('does not re-hide a restored tool once it is idle again', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    await ctx.tePrune.restore(sessionOf('s3'))
    // Enough idle sessions to qualify every other tool twice over.
    for (const id of ['s4', 's5', 's6', 's7']) await session(ctx, id)
    await createAgent(ctx, sessionOf('s8'))
    // Every candidate was restored, and four more idle sessions would qualify
    // them again: an empty deny list here is what "restored forever" means.
    expect(restricted).toEqual([])
  })
})

describe('bundle snapshot', () => {
  it('summarizes tracked tools and candidates from the recorded counters', async () => {
    const ctx = await mount({ idleSessions: 5 })
    const session = sessionOf('s-snap')
    const key = resolveRepoKey(repo).key
    const dir = join(stateRoot(), 'repos', repoKeyDirName(key))
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'prune.json'),
      JSON.stringify({
        version: 1,
        key,
        sessions: 12,
        tools: {
          web_search: { idle: 7, lastUsed: 2, uses: 1 },
          web_fetch: { idle: 6, lastUsed: 4, uses: 3 },
          read: { idle: 0, lastUsed: 9, uses: 40 },
        },
        restored: [],
      }),
    )

    const summary = await ctx.tePrune.snapshot(session)

    // `read` is tracked but protected, so it is counted and never a candidate.
    expect(summary).toEqual({
      sessions: 12,
      tracked: 3,
      candidates: ['web_search', 'web_fetch'],
      hiddenNow: 0,
      idleSessions: 5,
    })
  })
})

describe('reporting', () => {
  it('lists idle counters and the next decision', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    const text = ctx.tePrune.report(sessionOf('s3'))
    expect(text).toContain('web_search')
    expect(text).toContain('hidden next session')
    expect(text).not.toContain('bash')
  })

  it('says so when nothing is measured', async () => {
    const ctx = await mount()
    expect(ctx.tePrune.report(sessionOf('s1'))).toContain('Nothing measured yet')
  })
})
