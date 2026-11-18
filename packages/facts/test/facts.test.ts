import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { stateRoot, repoKeyDirName, resolveRepoKey } from 'dsh-te-core'
import { apply, Config } from '../src/index.ts'

const REPAIR_FAILED = 'bash: pytest: command not found'
const REPAIR_COMMAND = ['pytest -q', 'python -m pytest -q'] as const

let home: string
let repo: string
let savedHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-te-facts-'))
  repo = await mkdtemp(join(tmpdir(), 'dsh-te-repo-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
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

/** Mount the component with a stub command service. */
async function mount(config: Partial<Config> = {}) {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  apply(ctx, { enabled: true, maxFacts: 4, maxChars: 600, ...config })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return ctx
}

/** Feed one shell call through the tools/result channel. */
function shell(ctx: Context, session: Session, command: string, ok: boolean, output = ''): void {
  ctx.emit(
    'tools/result',
    { name: 'bash', arguments: { command }, agent: { session } } as never,
    { isError: !ok, content: [{ type: 'text', text: output }] } as never,
  )
}

/** One session that hits the same repair and then ends. */
async function learnSession(ctx: Context, id: string): Promise<void> {
  const session = sessionOf(id)
  shell(ctx, session, REPAIR_COMMAND[0], false, REPAIR_FAILED)
  shell(ctx, session, REPAIR_COMMAND[1], true)
  await ctx.teFacts.settle(session)
}

/** Read the stored facts of the throwaway repository. */
async function storedFacts(): Promise<{
  tasks: number
  facts: { key: string; state: string; confirms: number[]; fired: number; firedWaste: number }[]
}> {
  const key = resolveRepoKey(repo).key
  const path = join(stateRoot(), 'repos', repoKeyDirName(key), 'facts.json')
  return JSON.parse(await readFile(path, 'utf8')) as never
}

/** Run the pre-step waterfall and return the admitted messages. */
async function preStep(ctx: Context, session: Session, turn: number, step: number) {
  const base = { kind: 'enter' as const, messages: [] as unknown[] }
  // The context's event map expects a real Agent; the component only reads
  // `agent.session`, so a loose view keeps the test honest without a driver.
  const dispatch = ctx as unknown as { waterfall: (...args: unknown[]) => Promise<unknown> }
  return (await dispatch.waterfall(
    'agent/pre-step',
    { agent: { session }, turn, step, messages: [], signal: undefined, modelSelection: undefined },
    async () => base,
  )) as { kind: string; messages: { content: { type: string; text: string }[] }[] }
}

describe('mounting', () => {
  it('does nothing when disabled', async () => {
    const ctx = await mount({ enabled: false })
    expect(ctx.teFacts).toBeUndefined()
  })

  it('exposes the component only, not other services', async () => {
    const ctx = await mount()
    expect(typeof ctx.teFacts.settle).toBe('function')
    expect(typeof ctx.teFacts.report).toBe('function')
  })
})

describe('learning', () => {
  it('stores a candidate after one session', async () => {
    const ctx = await mount()
    await learnSession(ctx, 's1')
    const state = await storedFacts()
    expect(state.tasks).toBe(1)
    expect(state.facts).toHaveLength(1)
    expect(state.facts[0]?.key).toBe('form-repair:pytest:pytest')
    expect(state.facts[0]?.state).toBe('candidate')
    expect(state.facts[0]?.confirms).toEqual([1])
  })

  it('counts a situation as exercised even before it is ever injected', async () => {
    const ctx = await mount()
    await learnSession(ctx, 's1')
    expect((await storedFacts()).facts[0]?.fired).toBe(1)
  })

  it('promotes after three separate sessions', async () => {
    const ctx = await mount()
    for (const id of ['s1', 's2', 's3']) await learnSession(ctx, id)
    const state = await storedFacts()
    expect(state.facts[0]?.state).toBe('active')
    expect(state.facts[0]?.confirms).toEqual([1, 2, 3])
  })

  it('contradicts a stored fact after its failing form succeeds twice', async () => {
    const ctx = await mount()
    for (const id of ['s1', 's2', 's3']) await learnSession(ctx, id)
    // One clean success is a noisy task, not a reversal: the fact survives it.
    const noisy = sessionOf('s4')
    shell(ctx, noisy, REPAIR_COMMAND[0], true)
    await ctx.teFacts.settle(noisy)
    expect((await storedFacts()).facts[0]?.state).toBe('active')

    const second = sessionOf('s5')
    shell(ctx, second, REPAIR_COMMAND[0], true)
    await ctx.teFacts.settle(second)
    expect((await storedFacts()).facts[0]?.state).toBe('retired')
  })

  it('survives a session that touched nothing', async () => {
    const ctx = await mount()
    await learnSession(ctx, 's1')
    await ctx.teFacts.settle(sessionOf('empty'))
    const state = await storedFacts()
    expect(state.tasks).toBe(2)
    expect(state.facts[0]?.fired).toBe(1)
  })
})

describe('injection', () => {
  it('injects nothing before the firing gate clears', async () => {
    const ctx = await mount()
    await learnSession(ctx, 's1')
    const decision = await preStep(ctx, sessionOf('s2'), 1, 1)
    expect(decision.messages).toEqual([])
  })

  it('injects the learned fact once the gate clears', async () => {
    const ctx = await mount()
    for (const id of ['s1', 's2', 's3', 's4']) await learnSession(ctx, id)
    const decision = await preStep(ctx, sessionOf('s5'), 1, 1)
    expect(decision.messages).toHaveLength(1)
    const text = decision.messages[0]?.content[0]?.text ?? ''
    expect(text).toContain('Facts learned from earlier sessions')
    expect(text).toContain('`pytest` fails here')
    expect(text).toContain('`python -m pytest` works')
  })

  it('injects at the first step only', async () => {
    const ctx = await mount()
    for (const id of ['s1', 's2', 's3', 's4']) await learnSession(ctx, id)
    const later = await preStep(ctx, sessionOf('s5'), 2, 3)
    expect(later.messages).toEqual([])
  })

  it('keeps the injected block inside the character budget', async () => {
    const ctx = await mount({ maxChars: 220 })
    for (const id of ['s1', 's2', 's3', 's4']) await learnSession(ctx, id)
    const decision = await preStep(ctx, sessionOf('s5'), 1, 1)
    expect(decision.messages).toHaveLength(1)
    const text = decision.messages[0]?.content[0]?.text ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(text.length).toBeLessThanOrEqual(220)
    expect(text).toContain('`pytest` fails here')
  })

  it('injects nothing at all when not even the header fits', async () => {
    const ctx = await mount({ maxChars: 60 })
    for (const id of ['s1', 's2', 's3', 's4']) await learnSession(ctx, id)
    const decision = await preStep(ctx, sessionOf('s5'), 1, 1)
    expect(decision.messages).toEqual([])
  })

  it('does not repeat the block within one session', async () => {
    const ctx = await mount()
    for (const id of ['s1', 's2', 's3', 's4']) await learnSession(ctx, id)
    const session = sessionOf('s5')
    expect((await preStep(ctx, session, 1, 1)).messages).toHaveLength(1)
    expect((await preStep(ctx, session, 2, 1)).messages).toEqual([])
  })
})

describe('session lifecycle', () => {
  it('learns from the disposed event, not only from a direct settle call', async () => {
    const ctx = await mount()
    const session = sessionOf('s1')
    shell(ctx, session, REPAIR_COMMAND[0], false, REPAIR_FAILED)
    shell(ctx, session, REPAIR_COMMAND[1], true)
    ctx.emit('session/disposed', session)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const state = await storedFacts()
    expect(state.tasks).toBe(1)
    expect(state.facts).toHaveLength(1)
  })
})

describe('session shape', () => {
  it('does not count a subagent session as a repository task', async () => {
    const ctx = await mount()
    await learnSession(ctx, 's1')
    await learnSession(ctx, 's2')
    const child = { id: 'child-1', header: { cwd: repo, origin: 'subagent' } } as unknown as Session
    shell(ctx, child, REPAIR_COMMAND[0], false, REPAIR_FAILED)
    shell(ctx, child, REPAIR_COMMAND[1], true)
    await ctx.teFacts.settle(child)
    const state = await storedFacts()
    expect(state.tasks).toBe(2)
    expect(state.facts[0]?.confirms).toEqual([1, 2])
  })

  it('does not inject into a subagent session', async () => {
    const ctx = await mount()
    for (const id of ['s1', 's2', 's3', 's4']) await learnSession(ctx, id)
    const child = { id: 'child-2', header: { cwd: repo, origin: 'subagent' } } as unknown as Session
    expect((await preStep(ctx, child, 1, 1)).messages).toEqual([])
    expect((await preStep(ctx, sessionOf('s5'), 1, 1)).messages).toHaveLength(1)
  })
})

describe('retirement is not permanent', () => {
  it('lets a retired fact be learned again from fresh evidence', async () => {
    const ctx = await mount()
    for (const id of ['s1', 's2', 's3']) await learnSession(ctx, id)
    // The same form now succeeds twice: the repository disproved the claim.
    for (const id of ['s4', 's5']) {
      const disprover = sessionOf(id)
      shell(ctx, disprover, REPAIR_COMMAND[0], true)
      await ctx.teFacts.settle(disprover)
    }
    expect((await storedFacts()).facts[0]?.state).toBe('retired')

    // The repository changed back: a later session repeats the repair.
    const relearn = sessionOf('s6')
    shell(ctx, relearn, REPAIR_COMMAND[0], false, REPAIR_FAILED)
    shell(ctx, relearn, REPAIR_COMMAND[1], true)
    await ctx.teFacts.settle(relearn)
    const state = await storedFacts()
    expect(state.facts).toHaveLength(1)
    expect(state.facts[0]?.state).toBe('candidate')
    expect(state.facts[0]?.confirms).toEqual([6])
  })
})

describe('reporting', () => {
  it('lists the learned facts without a session log', async () => {
    const ctx = await mount()
    for (const id of ['s1', 's2', 's3']) await learnSession(ctx, id)
    const text = ctx.teFacts.report(sessionOf('s4'))
    expect(text).toContain('active')
    expect(text).toContain('python -m pytest')
  })

  it('says so when nothing is known', async () => {
    const ctx = await mount()
    expect(ctx.teFacts.report(sessionOf('s1'))).toContain('No facts learned yet')
  })
})
