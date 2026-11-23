import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

/** A session stand-in: the command only reads `id` and `header`. */
const session = { id: 's1', header: { cwd: '/tmp/repo' } }

/** Mount the bundle with the component services it reads, and return its command. */
async function mount(services: Record<string, unknown>) {
  const ctx = new Context()
  const registered: { name: string; handler: (invocation: unknown) => Promise<unknown> }[] = []
  ctx.provide('commands', {
    register: (definition: (typeof registered)[number]) => {
      registered.push(definition)
      return () => {}
    },
  } as never)
  for (const [name, value] of Object.entries(services)) ctx.provide(name as never, value as never)
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return registered[0]
}

const cost = {
  sessionSnapshot: () => ({ messages: 5, equivalent: 84_600, model: 'deepseek-v4.1-flash' }),
  repoSnapshot: async () => ({ equivalent: 2_100_000, sessions: 31, history: [] }),
}

const facts = {
  snapshot: async () => ({
    sessions: 31,
    total: 3,
    active: 2,
    candidate: 1,
    retired: 0,
    injectedTasks: 8,
    injectedTokens: 1_500,
  }),
}

const prune = {
  snapshot: async () => ({
    sessions: 31,
    tracked: 6,
    candidates: ['web_search', 'web_fetch'],
    hiddenNow: 1,
    idleSessions: 5,
  }),
}

describe('/te overview', () => {
  it('summarizes whatever components are mounted', async () => {
    const command = await mount({ teCost: cost, teFacts: facts, tePrune: prune })
    const result = (await command?.handler({ agent: { session } })) as { text: string }

    expect(result.text).toContain('cost     84.6k eq this session (5 req) · 2.10M eq over 31 repo sessions')
    expect(result.text).toContain('facts    31 sessions · 3 facts: 2 active · 1 candidate · 0 retired')
    expect(result.text).toContain('injected 8 tasks / 1.5k eq')
    expect(result.text).toContain('prune    31 sessions · 6 tools tracked · would hide web_search, web_fetch · 1 hidden now')
    expect(result.text).toContain('te-cost, te-facts, te-prune')
  })

  it('says which component is missing instead of hiding it', async () => {
    const command = await mount({ teCost: cost })
    const result = (await command?.handler({ agent: { session } })) as { text: string }

    expect(result.text).toContain('cost     84.6k eq this session')
    expect(result.text).toContain('facts    not installed')
    expect(result.text).toContain('prune    not installed')
  })

  it('reports a repository with no totals yet without inventing numbers', async () => {
    const command = await mount({ teCost: { ...cost, repoSnapshot: async () => undefined } })
    const result = (await command?.handler({ agent: { session } })) as { text: string }
    expect(result.text).toContain('no repo totals yet')
  })
})
