import { describe, expect, it } from 'vitest'
import {
  CLAUDE_5_WEIGHTS,
  DEFAULT_WEIGHTS,
  DEEPSEEK_FLASH_WEIGHTS,
  DEEPSEEK_PRO_WEIGHTS,
  GPT_5_6_SOL_WEIGHTS,
  PRO_FOLDED_INTO_FLASH_AT_MS,
  weightsFor,
} from '../src/index.ts'

const BEFORE_FOLD = PRO_FOLDED_INTO_FLASH_AT_MS - 1
const AFTER_FOLD = PRO_FOLDED_INTO_FLASH_AT_MS

describe('weightsFor', () => {
  it('prices DeepSeek flash routes at the published ratios', () => {
    const resolved = weightsFor('deepseek-v4.1-flash')
    expect(resolved.weights).toEqual(DEEPSEEK_FLASH_WEIGHTS)
    expect(resolved.source).toBe('deepseek-flash')
  })

  it('treats retired flash-class ids as flash', () => {
    expect(weightsFor('deepseek-v4-flash').weights).toEqual(DEEPSEEK_FLASH_WEIGHTS)
  })

  it('prices a pro route at the pro row only before the fold instant', () => {
    expect(weightsFor('deepseek-v4-pro', BEFORE_FOLD).weights).toEqual(DEEPSEEK_PRO_WEIGHTS)
    expect(weightsFor('deepseek-v4-pro', AFTER_FOLD).weights).toEqual(DEEPSEEK_FLASH_WEIGHTS)
  })

  it('prices Claude 5 and GPT-5.6 Sol from their own rows', () => {
    expect(weightsFor('claude-sonnet-5').weights).toEqual(CLAUDE_5_WEIGHTS)
    expect(weightsFor('gpt-5.6-sol').weights).toEqual(GPT_5_6_SOL_WEIGHTS)
  })

  it('falls back to the documented default instead of failing', () => {
    const resolved = weightsFor('some-unlisted-model')
    expect(resolved.weights).toEqual(DEFAULT_WEIGHTS)
    expect(resolved.source).toBe('default')
  })

  it('ignores a router provider prefix and letter case', () => {
    expect(weightsFor('anthropic/claude-sonnet-5').weights).toEqual(CLAUDE_5_WEIGHTS)
    expect(weightsFor('DeepSeek-V4.1-Flash').weights).toEqual(DEEPSEEK_FLASH_WEIGHTS)
  })
})
