import { describe, expect, it } from 'vitest'
import { formatTokens } from '../src/index.ts'

describe('formatTokens', () => {
  it('keeps small counts exact', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('renders thousands with one decimal', () => {
    expect(formatTokens(1_000)).toBe('1.0k')
    expect(formatTokens(12_345)).toBe('12.3k')
  })

  it('hands over to the next unit instead of printing 1000.0k', () => {
    expect(formatTokens(999_949)).toBe('999.9k')
    expect(formatTokens(999_960)).toBe('1.00M')
    expect(formatTokens(999_994_999)).toBe('999.99M')
    expect(formatTokens(999_995_000)).toBe('1.00B')
  })

  it('renders millions and billions with two decimals', () => {
    expect(formatTokens(1_234_567)).toBe('1.23M')
    expect(formatTokens(2_500_000_000)).toBe('2.50B')
  })

  it('keeps the sign of a negative count', () => {
    expect(formatTokens(-1_500)).toBe('-1.5k')
  })
})
