import { describe, expect, it } from 'vitest'
import { Config, name } from '../src/index.ts'

describe('dsh-te-prune', () => {
  it('carries the cordis plugin name', () => {
    expect(name).toBe('dsh-te-prune')
  })

  it('resolves its documented defaults', () => {
    const config = Config({ enabled: false, idleSessions: 5, maxHidden: 8, protected: [] })
    expect(config.idleSessions).toBe(5)
    expect(config.maxHidden).toBe(8)
  })

  it('resolves its defaults from an empty config', () => {
    const defaults = Config({} as never)
    expect(defaults.enabled).toBe(false)
    expect(defaults.idleSessions).toBe(5)
    expect(defaults.maxHidden).toBe(8)
    expect(defaults.protected).toEqual([])
  })

  it('ships with pruning switched off', () => {
    expect(Config({ enabled: false, idleSessions: 5, maxHidden: 8, protected: [] }).enabled).toBe(false)
  })
})
