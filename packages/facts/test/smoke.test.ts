import { describe, expect, it } from 'vitest'
import { Config, name } from '../src/index.ts'

describe('dsh-te-facts', () => {
  it('carries the cordis plugin name', () => {
    expect(name).toBe('dsh-te-facts')
  })

  it('resolves its documented defaults', () => {
    const config = Config({ enabled: true, maxFacts: 4, maxChars: 600 })
    expect(config.enabled).toBe(true)
    expect(config.maxFacts).toBe(4)
  })
})
