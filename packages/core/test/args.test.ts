import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/index.ts'

describe('parseArgs', () => {
  it('separates positionals from flags', () => {
    const parsed = parseArgs('repo github.com/a/b')
    expect(parsed.words).toEqual(['repo', 'github.com/a/b'])
    expect(parsed.flags).toEqual({})
  })

  it('reads --name=value', () => {
    const parsed = parseArgs('trend --since=2026-01-01')
    expect(parsed.words).toEqual(['trend'])
    expect(parsed.flags).toEqual({ since: '2026-01-01' })
  })

  it('keeps a bare flag from swallowing the word after it', () => {
    const parsed = parseArgs('repo --json github.com/a/b')
    expect(parsed.words).toEqual(['repo', 'github.com/a/b'])
    expect(parsed.flags).toEqual({ json: true })
  })

  it('binds a numeric value to a bare flag', () => {
    const parsed = parseArgs('trend --days 7')
    expect(parsed.flags).toEqual({ days: '7' })
    expect(parsed.words).toEqual(['trend'])
  })

  it('binds a negative or decimal number', () => {
    expect(parseArgs('trend --offset -3').flags).toEqual({ offset: '-3' })
    expect(parseArgs('trend --rate 0.5').flags).toEqual({ rate: '0.5' })
  })

  it('ignores an empty input and stray separators', () => {
    expect(parseArgs('')).toEqual({ words: [], flags: {} })
    expect(parseArgs('   ')).toEqual({ words: [], flags: {} })
    expect(parseArgs('-- stats').words).toEqual(['stats'])
  })

  it('does not mutate anything it was given', () => {
    const raw = 'stats --json'
    parseArgs(raw)
    expect(raw).toBe('stats --json')
  })
})
