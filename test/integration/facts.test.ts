import { afterEach, describe, expect, it } from 'vitest'

import { makeShellTool, startHarness, type Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** Seed one active fact that the fire gate accepts (4 firings, 3 still wasteful). */
function seedInjectableFact(h: Harness): void {
  h.writeRepo('facts.json', {
    version: 1,
    key: 'remote:github.com/integration/fixture',
    tasks: 3,
    facts: [
      {
        key: 'form-repair:pytest:python -m pytest',
        family: 'form-repair',
        intent: 'pytest',
        text: '`python -m pytest` fails here with command-not-found; `pytest` works.',
        confirms: [1, 2, 3],
        contradicts: [],
        fired: 4,
        firedWaste: 3,
        state: 'active',
      },
    ],
  })
}

describe('facts, end to end', () => {
  it('injects a qualified fact into the first model request', async () => {
    harness = await startHarness({ components: ['facts'] })
    seedInjectableFact(harness)

    const agent = await harness.agent()
    await harness.turn(agent, 'run the tests')

    expect(harness.requests).toHaveLength(1)
    const injected = harness.requests[0]!.messages.filter((message) => message.source === 'dsh-te-facts')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.text).toContain('Facts learned from earlier sessions in this repository')
    expect(injected[0]!.text).toContain('`python -m pytest` fails here')

    // Ending the session books the spend against the task it happened in.
    await harness.end(agent)
    const state = harness.readRepo('facts.json') as
      | { version: number; facts: { injectedTasks: number[]; injectedTokens: number }[] }
      | undefined
    expect(state?.version).toBe(2)
    expect(state?.facts[0]?.injectedTasks).toEqual([4])
    expect(state?.facts[0]?.injectedTokens).toBeGreaterThan(0)
  })

  it('injects nothing when the stored fact is not qualified', async () => {
    harness = await startHarness({ components: ['facts'] })
    seedInjectableFact(harness)
    // One firing is not enough evidence that the fact still pays for itself.
    harness.writeRepo('facts.json', {
      version: 1,
      key: 'remote:github.com/integration/fixture',
      tasks: 3,
      facts: [
        {
          key: 'form-repair:pytest:python -m pytest',
          family: 'form-repair',
          intent: 'pytest',
          text: '`python -m pytest` fails here with command-not-found; `pytest` works.',
          confirms: [1, 2, 3],
          contradicts: [],
          fired: 1,
          firedWaste: 1,
          state: 'active',
        },
      ],
    })

    const agent = await harness.agent()
    await harness.turn(agent)

    const injected = harness.requests[0]!.messages.filter((message) => message.source === 'dsh-te-facts')
    expect(injected).toHaveLength(0)
  })

  it('learns a fact from a failing shell call followed by a working one', async () => {
    harness = await startHarness({
      components: ['facts'],
      tools: [makeShellTool()],
      script: ({ index }) => {
        if (index === 0) return { kind: 'tool', name: 'bash', args: { command: 'python -m pytest' } }
        if (index === 1) return { kind: 'tool', name: 'bash', args: { command: 'pytest' } }
        return { kind: 'text', text: 'DONE' }
      },
    })

    const agent = await harness.agent()
    await harness.turn(agent, 'run the tests')
    await harness.end(agent)

    const state = harness.readRepo('facts.json') as
      | { tasks: number; facts: { key: string; family: string; state: string }[] }
      | undefined
    expect(state).toBeDefined()
    expect(state?.tasks).toBe(1)
    const learned = state?.facts.find((fact) => fact.key === 'form-repair:pytest:python -m pytest')
    expect(learned).toBeDefined()
    expect(learned?.family).toBe('form-repair')
    expect(learned?.state).toBe('candidate')
  })
})
