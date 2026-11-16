import { describe, expect, it } from 'vitest'
import { Config, name } from '../src/index.ts'

describe('dsh-te-cost', () => {
  it('carries the cordis plugin name', () => {
    expect(name).toBe('dsh-te-cost')
  })

  it('resolves its documented defaults', () => {
    expect(Config({}).enabled).toBe(true)
  })
})
