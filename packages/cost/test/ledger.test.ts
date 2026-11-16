import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoKeyDirName, stateRoot } from '@sonettogu14/dsh-te-core'
import { CostLedger, apply } from '../src/index.ts'

/** Mount the plugin and let Cordis finish loading its fiber. */
async function mount(context: Context, config: { enabled: boolean; persist: boolean }): Promise<void> {
  apply(context, config)
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Drive the component through a real Cordis context.
 *
 * The command service is stubbed: this test is about accounting, not about the
 * command surface, and a stub keeps the test independent of dsh-commands'
 * session requirements.
 */
function fakeSession(id: string, cwd: string): Session {
  return { id, header: { cwd } } as unknown as Session
}

function routeEvent(provider: string, model: string): SessionEvent {
  return {
    type: 'request/header',
    seq: 1,
    time: 0,
    data: { header: { config: { provider, model } } },
  } as unknown as SessionEvent
}

function usageEvent(usage: Record<string, number>): SessionEvent {
  return { type: 'assistant/message', seq: 2, time: 0, data: { usage } } as unknown as SessionEvent
}

let ctx: Context
let registrations: {
  name: string
  description: string
  input?: { hint?: string }
  handler: (invocation: { agent: { session: Session }; rawInput: string }) => unknown
}[]
let home: string
let savedHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-te-cost-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  ctx = new Context()
  registrations = []
  ctx.provide('commands', {
    register: (definition: (typeof registrations)[number]) => {
      registrations.push(definition)
      return () => {}
    },
  } as never)
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  await rm(home, { recursive: true, force: true })
})

describe('dsh-te-cost surface', () => {
  it('touches no prompt or tool surface, only the command service', () => {
    // Accounting is a pure observer: the whole point is that mounting it cannot
    // change what the model sees, so its only injected service is `commands`.
    expect(CostLedger.inject).toEqual(['commands'])
  })
})

describe('dsh-te-cost ledger', () => {
  it('folds usage into equivalent tokens and reports them', async () => {
    await mount(ctx, { enabled: true, persist: false })
    const session = fakeSession('sess-0001', '/tmp/repo')
    ctx.emit('session/event', session, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', session, usageEvent({ inputTokens: 1000, cacheReadTokens: 10_000, outputTokens: 500 }))

    const snapshot = ctx.teCost.sessionSnapshot(session)
    expect(snapshot.model).toBe('deepseek-v4.1-flash')
    expect(snapshot.messages).toBe(1)
    expect(snapshot.equivalent).toBeCloseTo(3200, 6)
    expect(snapshot.buckets).toEqual({ uncachedInput: 1000, cacheRead: 10_000, cacheWrite: 0, output: 500 })

    const text = ctx.teCost.report(session, '')
    expect(text).toContain('equivalent 3.2k eq')
    expect(text).toContain('requests 1')
    expect(registrations.map((definition) => definition.name)).toEqual(['te-cost'])
    expect(registrations[0]?.description).toContain('equivalent-token')
  })

  it('bills recorded overhead against the same account', async () => {
    await mount(ctx, { enabled: true, persist: false })
    const session = fakeSession('sess-0002', '/tmp/repo')
    ctx.emit('session/event', session, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', session, usageEvent({ inputTokens: 100, outputTokens: 0 }))
    ctx.teCost.recordOverhead(session, 'facts', 40)
    expect(ctx.teCost.sessionSnapshot(session).overhead).toBe(40)
    expect(ctx.teCost.report(session, '')).toContain('overhead 40 eq (facts 40)')
  })

  it('prices an unknown route with the default row instead of throwing', async () => {
    await mount(ctx, { enabled: true, persist: false })
    const session = fakeSession('sess-0003', '/tmp/repo')
    ctx.emit('session/event', session, routeEvent('someone', 'mystery-model'))
    ctx.emit('session/event', session, usageEvent({ inputTokens: 100, outputTokens: 0 }))
    expect(ctx.teCost.sessionSnapshot(session).weightsSource).toBe('default')
    expect(ctx.teCost.sessionSnapshot(session).equivalent).toBeCloseTo(100, 6)
  })

  it('persists repo totals atomically and folds a second session onto them', async () => {
    await mount(ctx, { enabled: true, persist: true })
    const session = fakeSession('sess-0004', '/tmp/repo-persist')
    ctx.emit('session/event', session, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', session, usageEvent({ inputTokens: 1000, outputTokens: 0 }))
    await ctx.teCost.settle(session)

    const root = stateRoot()
    const record = JSON.parse(await readFile(join(root, 'repos', repoKeyDirName('path:/tmp/repo-persist'), 'cost.json'), 'utf8'))
    expect(record).toMatchObject({ version: 1, key: 'path:/tmp/repo-persist', sessions: 1 })
    expect(record.equivalent).toBeCloseTo(1000, 6)

    const second = fakeSession('sess-0005', '/tmp/repo-persist')
    ctx.emit('session/event', second, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', second, usageEvent({ inputTokens: 4000, outputTokens: 0 }))
    await ctx.teCost.settle(second)

    const folded = JSON.parse(await readFile(join(root, 'repos', repoKeyDirName('path:/tmp/repo-persist'), 'cost.json'), 'utf8'))
    expect(folded.sessions).toBe(2)
    expect(folded.equivalent).toBeCloseTo(5000, 6)
    expect(folded.buckets.uncachedInput).toBe(5000)
  })

  it('contributes nothing when disabled', async () => {
    await mount(ctx, { enabled: false, persist: false })
    expect(ctx.teCost).toBeUndefined()
  })
})

describe('session lifecycle and the command', () => {
  it('writes the repo ledger from the disposed event, not by hand', async () => {
    await mount(ctx, { enabled: true, persist: true })
    const session = fakeSession('sess-0006', '/tmp/repo-disposed')
    ctx.emit('session/event', session, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', session, usageEvent({ inputTokens: 700, outputTokens: 0 }))
    ctx.emit('session/disposed', session)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const record = JSON.parse(
      await readFile(join(stateRoot(), 'repos', repoKeyDirName('path:/tmp/repo-disposed'), 'cost.json'), 'utf8'),
    )
    expect(record.sessions).toBe(1)
    expect(record.equivalent).toBeCloseTo(700, 6)
  })

  it('answers /te-cost repo with the stored repository total', async () => {
    await mount(ctx, { enabled: true, persist: true })
    const session = fakeSession('sess-0007', '/tmp/repo-command')
    ctx.emit('session/event', session, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', session, usageEvent({ inputTokens: 2000, outputTokens: 0 }))
    await ctx.teCost.settle(session)
    const definition = registrations[0]
    const result = (await definition?.handler({ agent: { session }, rawInput: 'repo' })) as {
      kind: string
      text: string
    }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('repo path:/tmp/repo-command')
    expect(result.text).toContain('2.0k eq')
    expect(definition?.input?.hint).toContain('repo')
  })

  it('counts cache writes in the session and the report', async () => {
    await mount(ctx, { enabled: true, persist: false })
    const session = fakeSession('sess-0008', '/tmp/repo')
    ctx.emit('session/event', session, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit(
      'session/event',
      session,
      usageEvent({ inputTokens: 0, cacheWriteTokens: 100, cacheReadTokens: 0, outputTokens: 0 }),
    )
    const snapshot = ctx.teCost.sessionSnapshot(session)
    expect(snapshot.buckets.cacheWrite).toBe(100)
    // flash writes cache at 1x fresh input
    expect(snapshot.equivalent).toBeCloseTo(100, 6)
  })
})
