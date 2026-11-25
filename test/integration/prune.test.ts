import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { startHarness, type Harness } from './harness.ts'
import type { ToolFixture } from './harness.ts'

/**
 * The `enabled` the install-all bundle ships for prune.
 *
 * Read rather than hardcoded: the value is the contract this test guards, and a
 * default that changes has to change here too instead of silently untested.
 */
function shippedEnabled(): boolean {
  const path = fileURLToPath(new URL('../../packages/bundle/cordis.patch.yml', import.meta.url))
  const match = /- id: te-prune[\s\S]*?enabled:\s*(true|false)/.exec(readFileSync(path, 'utf8'))
  if (match?.[1] === undefined) throw new Error('the bundle no longer declares a te-prune config')
  return match[1] === 'true'
}

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

function tool(name: string, run: () => unknown = () => `${name} ok`): ToolFixture {
  return { name, run: () => run() }
}

/** Seed idle counters: `idle` sessions without a call, so pruning qualifies. */
function seedIdle(h: Harness, idle: Record<string, number>): void {
  const tools: Record<string, { idle: number; lastUsed: number; uses: number }> = {}
  for (const [name, sessions] of Object.entries(idle)) {
    tools[name] = { idle: sessions, lastUsed: 0, uses: 0 }
  }
  h.writeRepo('prune.json', {
    version: 1,
    key: 'remote:github.com/integration/fixture',
    sessions: 6,
    tools,
    restored: [],
  })
}

describe('prune, end to end', () => {
  it('hides an idle tool from the model request without unregistering it', async () => {
    harness = await startHarness({ components: ['prune'], tools: [tool('idle_tool'), tool('active_tool')] })
    seedIdle(harness, { idle_tool: 6 })

    const agent = await harness.agent()
    await harness.turn(agent)

    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]!.toolNames).not.toContain('idle_tool')
    expect(harness.requests[0]!.toolNames).toContain('active_tool')

    // The mask is per agent: the registry still knows the tool, so another
    // session (or a later one) can see it again.
    const registryNames = (harness.ctx.tools as unknown as { schemas(): { name: string }[] })
      .schemas()
      .map((schema) => schema.name)
    expect(registryNames).toContain('idle_tool')
  })

  it('keeps a tool that is still being used', async () => {
    harness = await startHarness({
      components: ['prune'],
      tools: [tool('fresh_tool', () => 'fresh ok')],
      script: ({ index }) =>
        index === 0 ? { kind: 'tool', name: 'fresh_tool', args: {} } : { kind: 'text', text: 'DONE' },
    })
    // Below the threshold: 4 idle sessions, 5 required.
    seedIdle(harness, { fresh_tool: 4 })

    const agent = await harness.agent()
    await harness.turn(agent)

    expect(harness.requests[0]!.toolNames).toContain('fresh_tool')
    expect(harness.requests).toHaveLength(2)
  })

  it('never hides the external compressor tools', async () => {
    harness = await startHarness({
      components: ['prune'],
      tools: [tool('acp_retrieve'), tool('acp_status'), tool('acp_cache'), tool('idle_tool')],
    })
    seedIdle(harness, { acp_retrieve: 20, acp_status: 20, acp_cache: 20, idle_tool: 6 })

    const agent = await harness.agent()
    await harness.turn(agent)

    // Hiding one of these leaves the model calling a tool the compressor's own
    // prompt sections still advertise.
    const names = harness.requests[0]!.toolNames
    expect(names).toContain('acp_retrieve')
    expect(names).toContain('acp_status')
    expect(names).toContain('acp_cache')
    expect(names).not.toContain('idle_tool')
  })

  it('mounts, measures and answers its command with the bundle default', async () => {
    // 0.4.0 returned from `apply` when disabled, so the entry looked enabled in
    // the Plugins page while the service and the command never existed. The
    // shipped default is the configuration every user starts in, so it is the
    // one that has to be exercised.
    const enabled = shippedEnabled()
    harness = await startHarness({
      components: ['prune'],
      prune: { enabled },
      tools: [tool('idle_tool'), tool('active_tool')],
    })
    seedIdle(harness, { idle_tool: 20 })

    const agent = await harness.agent()
    await harness.turn(agent)

    expect(harness.ctx.get('tePrune')).toBeDefined()
    const names = harness.requests[0]!.toolNames
    if (enabled) expect(names).not.toContain('idle_tool')
    else expect(names).toContain('idle_tool')

    // The command existing is what /te and the slash menu both depend on.
    const result = (await harness.command(agent, '/te-prune')) as { kind: string; text?: string }
    expect(result).toBeDefined()
    expect(result.kind).toBe('success')
    expect(result.text).toContain('idle_tool')

    // Measuring is independent of hiding: the counters still land on disk.
    await harness.end(agent)
    const state = harness.readRepo('prune.json') as
      | { sessions: number; tools: Record<string, { idle: number }> }
      | undefined
    // Six seeded sessions plus the one that just ended.
    expect(state?.sessions).toBe(7)
    expect(state?.tools.idle_tool).toBeDefined()
  })

  it('never hides a protected tool, whatever its idle count', async () => {
    harness = await startHarness({ components: ['prune'], tools: [tool('write'), tool('idle_tool')] })
    seedIdle(harness, { write: 20, idle_tool: 6 })

    const agent = await harness.agent()
    await harness.turn(agent)

    expect(harness.requests[0]!.toolNames).toContain('write')
    expect(harness.requests[0]!.toolNames).not.toContain('idle_tool')
  })
})
