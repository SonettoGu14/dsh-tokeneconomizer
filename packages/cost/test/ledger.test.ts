import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoKeyDirName, resolveRepoKey, stateRoot } from 'dsh-te-core'
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
    expect(record).toMatchObject({ version: 2, key: 'path:/tmp/repo-persist', sessions: 1, droppedSessions: 0 })
    expect(record.equivalent).toBeCloseTo(1000, 6)
    expect(record.history).toHaveLength(1)
    expect(record.history[0]).toMatchObject({ sessionId: 'sess-0004', equivalent: 1000, weightsSource: 'deepseek-flash' })
    expect(record.history[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const second = fakeSession('sess-0005', '/tmp/repo-persist')
    ctx.emit('session/event', second, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', second, usageEvent({ inputTokens: 4000, outputTokens: 0 }))
    await ctx.teCost.settle(second)

    const folded = JSON.parse(await readFile(join(root, 'repos', repoKeyDirName('path:/tmp/repo-persist'), 'cost.json'), 'utf8'))
    expect(folded.sessions).toBe(2)
    expect(folded.equivalent).toBeCloseTo(5000, 6)
    expect(folded.buckets.uncachedInput).toBe(5000)
    expect(folded.history.map((item: { sessionId: string }) => item.sessionId)).toEqual(['sess-0004', 'sess-0005'])
  })

  it('updates a re-settled session instead of counting it twice', async () => {
    await mount(ctx, { enabled: true, persist: true })
    const session = fakeSession('sess-resettle', '/tmp/repo-resettle')
    ctx.emit('session/event', session, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', session, usageEvent({ inputTokens: 1000, outputTokens: 0 }))
    await ctx.teCost.settle(session)
    await ctx.teCost.settle(session)

    const record = JSON.parse(
      await readFile(join(stateRoot(), 'repos', repoKeyDirName('path:/tmp/repo-resettle'), 'cost.json'), 'utf8'),
    )
    // The history replaces by session id, so the totals must not grow either.
    expect(record.sessions).toBe(1)
    expect(record.equivalent).toBeCloseTo(1000, 6)
    expect(record.history).toHaveLength(1)
  })

  it('upgrades a v1 record and counts its sessions as dropped detail', async () => {
    const dir = join(stateRoot(), 'repos', repoKeyDirName('path:/tmp/repo-v1'))
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'cost.json'),
      JSON.stringify({
        version: 1,
        key: 'path:/tmp/repo-v1',
        equivalent: 500,
        buckets: { uncachedInput: 500, cacheRead: 0, cacheWrite: 0, output: 0 },
        sessions: 2,
        overhead: {},
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    )

    await mount(ctx, { enabled: true, persist: true })
    const session = fakeSession('sess-v1', '/tmp/repo-v1')
    ctx.emit('session/event', session, routeEvent('deepseek', 'deepseek-v4.1-flash'))
    ctx.emit('session/event', session, usageEvent({ inputTokens: 1000, outputTokens: 0 }))
    await ctx.teCost.settle(session)

    const record = JSON.parse(await readFile(join(dir, 'cost.json'), 'utf8'))
    expect(record.version).toBe(2)
    expect(record.sessions).toBe(3)
    expect(record.equivalent).toBeCloseTo(1500, 6)
    expect(record.history).toHaveLength(1)
    expect(record.droppedSessions).toBe(2)
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
    expect(result.text).toContain('history 1 sessions')
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

/** Write a v2 cost record for one repository key. */
async function writeRecord(key: string, record: Record<string, unknown>): Promise<void> {
  const dir = join(stateRoot(), 'repos', repoKeyDirName(key))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cost.json'), JSON.stringify({ version: 2, key, ...record }))
}

const ZERO = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

describe('trend report', () => {
  it('groups history by day, quotes a subagent-free median and shows the cap', async () => {
    await mount(ctx, { enabled: true, persist: true })
    const session = fakeSession('sess-trend', '/tmp/repo-trend')
    const key = resolveRepoKey('/tmp/repo-trend').key
    const base = {
      startedAt: '2026-11-18T09:00:00.000Z',
      endedAt: '2026-11-18T10:00:00.000Z',
      buckets: ZERO,
      overhead: {},
      weightsSource: 'known',
    }
    await writeRecord(key, {
      equivalent: 202_000,
      buckets: ZERO,
      sessions: 3,
      overhead: {},
      updatedAt: base.endedAt,
      history: [
        { ...base, sessionId: 'a', day: '2026-11-18', equivalent: 100_000 },
        { ...base, sessionId: 'b', day: '2026-11-18', equivalent: 60_000 },
        { ...base, sessionId: 'c', day: '2026-11-19', equivalent: 42_000, subagent: true },
      ],
      droppedSessions: 2,
    })

    await ctx.teCost.repoSnapshot(session)
    const text = ctx.teCost.report(session, 'trend')

    expect(text).toContain('3 sessions over 2 days · 2 oldest dropped')
    expect(text).toContain('2026-11-18')
    // The subagent session is counted in the totals but not in the median.
    expect(text).toContain('median 80.0k eq per session')
    expect(text).toContain('1 subagent sessions excluded from the per-session median')
  })

  it('says so when a repository has no history yet', async () => {
    await mount(ctx, { enabled: true, persist: true })
    const session = fakeSession('sess-empty', '/tmp/repo-empty')
    const key = resolveRepoKey('/tmp/repo-empty').key
    await writeRecord(key, { equivalent: 0, buckets: ZERO, sessions: 0, overhead: {}, updatedAt: '', history: [], droppedSessions: 0 })
    await ctx.teCost.repoSnapshot(session)
    expect(ctx.teCost.report(session, 'trend')).toContain('trend none yet')
  })
})

describe('repos report', () => {
  it('lists every repository, most expensive first', async () => {
    await mount(ctx, { enabled: true, persist: true })
    const cheap = resolveRepoKey('/tmp/repo-cheap').key
    const dear = resolveRepoKey('/tmp/repo-dear').key
    await writeRecord(cheap, { equivalent: 1_000, buckets: ZERO, sessions: 1, overhead: {}, updatedAt: '', history: [], droppedSessions: 0 })
    await writeRecord(dear, { equivalent: 90_000, buckets: ZERO, sessions: 4, overhead: {}, updatedAt: '', history: [], droppedSessions: 0 })

    const result = (await registrations[0]?.handler({
      agent: { session: fakeSession('sess-repos', '/tmp/repo-dear') },
      rawInput: 'repos',
    })) as { text: string }

    expect(result.text).toContain('2 repositories')
    expect(result.text.indexOf(dear)).toBeLessThan(result.text.indexOf(cheap))
    expect(result.text).toContain('91.0k eq total')
  })

  it('answers without inventing a repository', async () => {
    await mount(ctx, { enabled: true, persist: true })
    const result = (await registrations[0]?.handler({
      agent: { session: fakeSession('sess-none', '/tmp/repo-dear') },
      rawInput: 'repos',
    })) as { text: string }
    expect(result.text).toBe('No repositories recorded yet.')
  })
})
