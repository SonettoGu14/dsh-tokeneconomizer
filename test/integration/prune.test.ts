import { afterEach, describe, expect, it } from 'vitest'

import { startHarness, type Harness } from './harness.ts'
import type { ToolFixture } from './harness.ts'

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

  it('never hides a protected tool, whatever its idle count', async () => {
    harness = await startHarness({ components: ['prune'], tools: [tool('write'), tool('idle_tool')] })
    seedIdle(harness, { write: 20, idle_tool: 6 })

    const agent = await harness.agent()
    await harness.turn(agent)

    expect(harness.requests[0]!.toolNames).toContain('write')
    expect(harness.requests[0]!.toolNames).not.toContain('idle_tool')
  })
})
