import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { repoKeyDirName, resolveRepoKey, stateRoot } from '@gyk/dsh-te-core'
import { apply, Config } from '../src/index.ts'

const AVAILABLE = ['bash', 'read', 'web_search', 'web_fetch', 'mcp__zotero__search']

let home: string
let repo: string
let savedHome: string | undefined
let restricted: { deny?: readonly string[] }[]
let lifted: number

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

/** Mount the component with stub command and tool services. */
async function mount(config: Partial<Config> = {}) {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  ctx.provide('tools', {
    schemas: () => AVAILABLE.map((name) => ({ name })),
    restrict: (filter: { deny?: readonly string[] }) => {
      restricted.push(filter)
      return () => {
        lifted += 1
      }
    },
  } as never)
  apply(ctx, { enabled: true, idleSessions: 3, maxHidden: 8, protected: [], ...config })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return ctx
}

/** Feed one tool call through the tools/result channel. */
function used(ctx: Context, session: Session, tool: string): void {
  ctx.emit(
    'tools/result',
    { name: tool, arguments: {}, agent: { session } } as never,
    { isError: false, content: [] } as never,
  )
}

/** One session that used `tools` and then ended. */
async function session(ctx: Context, id: string, tools: string[] = ['bash']): Promise<void> {
  const target = sessionOf(id)
  for (const tool of tools) used(ctx, target, tool)
  await ctx.tePrune.settle(target)
}

/** Run the pre-step waterfall for a fresh session. */
async function preStep(ctx: Context, session: Session, turn = 1, step = 1): Promise<void> {
  const dispatch = ctx as unknown as { waterfall: (...args: unknown[]) => Promise<unknown> }
  await dispatch.waterfall(
    'agent/pre-step',
    { agent: { session }, turn, step, messages: [], signal: undefined, modelSelection: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )
}

/** Read the persisted pruning state. */
async function stored(): Promise<{ sessions: number; tools: Record<string, { idle: number; uses: number }> }> {
  const key = resolveRepoKey(repo).key
  return JSON.parse(await readFile(join(stateRoot(), 'repos', repoKeyDirName(key), 'prune.json'), 'utf8')) as never
}

describe('mounting', () => {
  it('is off unless enabled', async () => {
    const ctx = new Context()
    apply(ctx, { enabled: false, idleSessions: 5, maxHidden: 8, protected: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ctx.tePrune).toBeUndefined()
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
    await preStep(ctx, sessionOf('s3'))
    expect(restricted).toEqual([])
  })

  it('hides an idle tool once the threshold is reached', async () => {
    const ctx = await mount({ idleSessions: 3 })
    for (const id of ['s1', 's2', 's3']) await session(ctx, id)
    await preStep(ctx, sessionOf('s4'))
    expect(restricted).toHaveLength(1)
    expect(restricted[0]?.deny).toContain('web_search')
    expect(restricted[0]?.deny).toContain('web_fetch')
  })

  it('never hides the harness basics', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id, [])
    await preStep(ctx, sessionOf('s3'))
    expect(restricted[0]?.deny).not.toContain('bash')
    expect(restricted[0]?.deny).not.toContain('read')
  })

  it('hides at most maxHidden tools', async () => {
    const ctx = await mount({ idleSessions: 2, maxHidden: 1 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    await preStep(ctx, sessionOf('s3'))
    expect(restricted[0]?.deny).toHaveLength(1)
  })

  it('decides once per session, not on every step', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    const live = sessionOf('s3')
    await preStep(ctx, live, 1, 1)
    await preStep(ctx, live, 2, 3)
    expect(restricted).toHaveLength(1)
  })

  it('lifts the restriction when the session ends', async () => {
    const ctx = await mount({ idleSessions: 2 })
    for (const id of ['s1', 's2']) await session(ctx, id)
    const live = sessionOf('s3')
    await preStep(ctx, live)
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
    await preStep(ctx, sessionOf('s4'))
    expect(restricted).toEqual([])
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
