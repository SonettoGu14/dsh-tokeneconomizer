import { describe, expect, it } from 'vitest'
import {
  HISTORY_CAP,
  capHistory,
  dailyTrend,
  isSessionHistoryEntry,
  localDay,
  median,
  upsertHistory,
  type SessionHistoryEntry,
} from '../src/index.ts'

/** A complete history entry with overridable fields. */
function entry(sessionId: string, overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    sessionId,
    day: '2026-01-05',
    startedAt: '2026-01-05T10:00:00.000Z',
    endedAt: '2026-01-05T10:05:00.000Z',
    equivalent: 1_000,
    buckets: { uncachedInput: 100, cacheRead: 200, cacheWrite: 300, output: 400 },
    overhead: { facts: 40 },
    weightsSource: 'known',
    ...overrides,
  }
}

describe('localDay', () => {
  it('uses the local calendar day of the instant', () => {
    const evening = new Date(2026, 0, 5, 23, 30).toISOString()
    expect(localDay(evening)).toBe('2026-01-05')
    const morning = new Date(2026, 10, 18, 0, 5).toISOString()
    expect(localDay(morning)).toBe('2026-11-18')
  })

  it('returns an empty day for an unparsable instant', () => {
    expect(localDay('not a date')).toBe('')
  })
})

describe('upsertHistory', () => {
  it('appends a new session', () => {
    expect(upsertHistory([], entry('a')).map((item) => item.sessionId)).toEqual(['a'])
  })

  it('replaces an earlier settle of the same session in place', () => {
    const before = [entry('a'), entry('b')]
    const next = upsertHistory(before, entry('a', { equivalent: 2_000 }))
    expect(next.map((item) => item.sessionId)).toEqual(['a', 'b'])
    expect(next[0]?.equivalent).toBe(2_000)
    expect(before[0]?.equivalent).toBe(1_000)
  })
})

describe('capHistory', () => {
  it('keeps the newest entries and counts what it dropped', () => {
    const history = [entry('a'), entry('b'), entry('c')]
    const capped = capHistory(history, 2)
    expect(capped.entries.map((item) => item.sessionId)).toEqual(['b', 'c'])
    expect(capped.dropped).toBe(1)
  })

  it('drops nothing when the history fits, and copies it', () => {
    const history = [entry('a')]
    const capped = capHistory(history, HISTORY_CAP)
    expect(capped.dropped).toBe(0)
    expect(capped.entries).toEqual(history)
    expect(capped.entries).not.toBe(history)
  })
})

describe('isSessionHistoryEntry', () => {
  it('accepts what this version writes', () => {
    expect(isSessionHistoryEntry(entry('a'))).toBe(true)
  })

  it('rejects a record missing the fields the trend needs', () => {
    const { endedAt: _endedAt, ...withoutEnd } = entry('a')
    expect(isSessionHistoryEntry(withoutEnd)).toBe(false)
    expect(isSessionHistoryEntry({ ...entry('a'), buckets: null })).toBe(false)
    expect(isSessionHistoryEntry(null)).toBe(false)
    expect(isSessionHistoryEntry('a')).toBe(false)
  })
})
describe('dailyTrend', () => {
  it('sums equivalents and counts sessions per day, oldest first', () => {
    const days = dailyTrend([
      entry('a', { day: '2026-01-06', equivalent: 2_000 }),
      entry('b', { day: '2026-01-05', equivalent: 1_000 }),
      entry('c', { day: '2026-01-06', equivalent: 500 }),
    ])
    expect(days).toEqual([
      { day: '2026-01-05', sessions: 1, equivalent: 1_000 },
      { day: '2026-01-06', sessions: 2, equivalent: 2_500 },
    ])
  })

  it('ignores an entry whose day could not be parsed', () => {
    expect(dailyTrend([entry('a', { day: '' })])).toEqual([])
  })
})

describe('median', () => {
  it('takes the middle value and averages a pair', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  it('does not mutate the sample', () => {
    const sample = [3, 1, 2]
    median(sample)
    expect(sample).toEqual([3, 1, 2])
  })
})
