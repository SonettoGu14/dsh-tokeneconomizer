import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJson, resolveDshHome, writeJsonAtomic } from '../src/index.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-te-storage-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('resolveDshHome', () => {
  it('prefers DSH_HOME and expands a leading tilde', () => {
    expect(resolveDshHome({ DSH_HOME: '~/state' }, home)).toBe(join(home, 'state'))
    expect(resolveDshHome({ DSH_HOME: '/abs/state' }, home)).toBe('/abs/state')
  })

  it('resolves a relative DSH_HOME against home, never the checkout', () => {
    // Resolving against cwd would split state per launch directory, and inside a
    // repository it would write the state file where git can publish it.
    expect(resolveDshHome({ DSH_HOME: 'state' }, home)).toBe(join(home, 'state'))
  })

  it('falls back to ~/.dsh', () => {
    expect(resolveDshHome({}, home)).toBe(join(home, '.dsh'))
  })
})

describe('readJson', () => {
  it('returns undefined for a missing file', async () => {
    expect(await readJson(join(home, 'nope.json'))).toBeUndefined()
  })

  it('returns undefined for corruption and for a bare JSON null', async () => {
    const path = join(home, 'state.json')
    await writeJsonAtomic(path, { ok: true })
    expect(await readJson(path)).toEqual({ ok: true })
    await writeJsonAtomic(path, null)
    // `null` parses, but callers read properties off the result.
    expect(await readJson(path)).toBeUndefined()
    await writeJsonAtomic(path, 42)
    expect(await readJson(path)).toBeUndefined()
  })
})

describe('writeJsonAtomic', () => {
  it('writes owner-only files and lets concurrent writers both succeed', async () => {
    const path = join(home, 'nested', 'state.json')
    // Two writers in the same millisecond used to collide on one temp name.
    const results = await Promise.allSettled([
      writeJsonAtomic(path, { writer: 1 }),
      writeJsonAtomic(path, { writer: 2 }),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    const stored = await readJson<{ writer: number }>(path)
    expect([1, 2]).toContain(stored?.writer)
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    const parsed = JSON.parse(await readFile(path, 'utf8')) as { writer: number }
    expect([1, 2]).toContain(parsed.writer)
  })
})
