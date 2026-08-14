import { describe, expect, it } from 'vitest'
import {
  addDays,
  APP_TIMEZONE,
  ClockError,
  contains,
  daysBetween,
  endOfDayExclusive,
  endOfMonthExclusive,
  fromLocalDate,
  horizonInterval,
  isSameLocalDay,
  isSameLocalMonth,
  monthInterval,
  startOfDay,
  startOfMonth,
  toLocalDate,
  trailingMonthIntervals,
  zonedParts,
  zoneOffsetMs,
} from '@/lib/domain/clock'

/**
 * These are the tests that catch the bug the plan calls invisible until you
 * reconcile a month. Hong Kong is UTC+8, so the last eight hours of every local
 * month fall on the *next* UTC day — bucket in UTC and that spending silently
 * lands in the wrong month, every month.
 */
describe('timezone bucketing — the month-boundary bug', () => {
  // 2026-01-31 23:30 Hong Kong time
  const lateJan = new Date('2026-01-31T15:30:00Z')
  // 2026-02-01 00:30 Hong Kong time — the same UTC day as lateJan
  const earlyFeb = new Date('2026-01-31T16:30:00Z')

  it('places 23:30 on the last day of the month in that month', () => {
    const p = zonedParts(lateJan)
    expect([p.year, p.month, p.day, p.hour]).toEqual([2026, 1, 31, 23])
  })

  it('places 00:30 on the first of the month in the new month', () => {
    const p = zonedParts(earlyFeb)
    expect([p.year, p.month, p.day, p.hour]).toEqual([2026, 2, 1, 0])
  })

  it('puts two instants 1 hour apart in different months', () => {
    // Both are 2026-01-31 in UTC. Only local bucketing separates them.
    expect(earlyFeb.getTime() - lateJan.getTime()).toBe(3_600_000)
    expect(lateJan.toISOString().slice(0, 10)).toBe(earlyFeb.toISOString().slice(0, 10))
    expect(isSameLocalMonth(lateJan, earlyFeb)).toBe(false)
    expect(isSameLocalDay(lateJan, earlyFeb)).toBe(false)
  })

  it('bounds January by local midnight, not UTC midnight', () => {
    const jan = monthInterval(lateJan)
    expect(jan.start.toISOString()).toBe('2025-12-31T16:00:00.000Z')
    expect(jan.endExclusive.toISOString()).toBe('2026-01-31T16:00:00.000Z')

    expect(contains(jan, lateJan)).toBe(true)
    expect(contains(jan, earlyFeb)).toBe(false)
  })

  it('bounds February correctly, including its short length', () => {
    const feb = monthInterval(earlyFeb)
    expect(feb.start.toISOString()).toBe('2026-01-31T16:00:00.000Z')
    expect(feb.endExclusive.toISOString()).toBe('2026-02-28T16:00:00.000Z')
    expect(contains(feb, earlyFeb)).toBe(true)
  })

  it('rolls December into the next year', () => {
    const dec = new Date('2026-12-15T00:00:00Z')
    expect(startOfMonth(dec).toISOString()).toBe('2026-11-30T16:00:00.000Z')
    expect(endOfMonthExclusive(dec).toISOString()).toBe('2026-12-31T16:00:00.000Z')
  })
})

describe('offsets', () => {
  it('reports Hong Kong as a fixed UTC+8 in both halves of the year', () => {
    const eightHours = 8 * 3_600_000
    expect(zoneOffsetMs(new Date('2026-01-15T00:00:00Z'))).toBe(eightHours)
    expect(zoneOffsetMs(new Date('2026-07-15T00:00:00Z'))).toBe(eightHours)
  })

  it('still handles a DST zone correctly', () => {
    // Not the app zone, but the module must not silently assume fixed offsets.
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Europe/London')).toBe(0)
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'Europe/London')).toBe(3_600_000)
  })

  it('rejects an unknown timezone', () => {
    expect(() => zonedParts(new Date(), 'Mars/Olympus_Mons')).toThrow(ClockError)
  })

  it('rejects an invalid Date', () => {
    expect(() => zonedParts(new Date('nonsense'))).toThrow(ClockError)
  })
})

describe('day buckets', () => {
  const midday = new Date('2026-03-10T04:00:00Z') // 12:00 HKT

  it('starts the day at local midnight', () => {
    expect(startOfDay(midday).toISOString()).toBe('2026-03-09T16:00:00.000Z')
  })

  it('ends the day at the next local midnight, exclusive', () => {
    expect(endOfDayExclusive(midday).toISOString()).toBe('2026-03-10T16:00:00.000Z')
  })

  it('adds calendar days across a month boundary', () => {
    const jan31 = new Date('2026-01-31T04:00:00Z') // 12:00 HKT
    expect(toLocalDate(addDays(jan31, 1))).toBe('2026-02-01')
    expect(toLocalDate(addDays(jan31, 29))).toBe('2026-03-01')
    expect(toLocalDate(addDays(jan31, -31))).toBe('2025-12-31')
  })

  it('preserves local wall-clock time when adding days', () => {
    const before = zonedParts(midday)
    const after = zonedParts(addDays(midday, 45))
    expect([after.hour, after.minute]).toEqual([before.hour, before.minute])
  })

  it('rejects a fractional day count', () => {
    expect(() => addDays(midday, 1.5)).toThrow(ClockError)
  })

  it('counts whole local days between instants', () => {
    expect(daysBetween(new Date('2026-01-01T04:00:00Z'), new Date('2026-01-31T04:00:00Z'))).toBe(30)
    expect(daysBetween(new Date('2026-01-31T04:00:00Z'), new Date('2026-01-01T04:00:00Z'))).toBe(-30)
    // 23:30 → 00:30 the next local day is one day apart, though only an hour passes.
    expect(daysBetween(new Date('2026-01-31T15:30:00Z'), new Date('2026-01-31T16:30:00Z'))).toBe(1)
  })
})

describe('local date strings', () => {
  it('round-trips a date through midnight and back', () => {
    for (const date of ['2026-01-01', '2026-02-28', '2026-12-31', '2024-02-29']) {
      expect(toLocalDate(fromLocalDate(date))).toBe(date)
    }
  })

  it('anchors a local date at local midnight', () => {
    expect(fromLocalDate('2026-08-11').toISOString()).toBe('2026-08-10T16:00:00.000Z')
  })

  it('rejects dates that do not exist rather than rolling them forward', () => {
    // Date.UTC would happily turn 2026-02-30 into 2026-03-02.
    expect(() => fromLocalDate('2026-02-30')).toThrow(/no such date/)
    expect(() => fromLocalDate('2025-02-29')).toThrow(/no such date/)
  })

  it('rejects malformed date strings', () => {
    for (const bad of ['2026-1-1', '11/08/2026', '2026-13-01', '2026-00-10', '2026-01-32', '']) {
      expect(() => fromLocalDate(bad), JSON.stringify(bad)).toThrow(ClockError)
    }
  })
})

describe('horizon interval — the committed-outflow window (PLAN §5)', () => {
  const now = new Date('2026-08-11T09:15:00Z') // 17:15 HKT

  it('starts at local midnight today, not at "now"', () => {
    // A bill due later today must be inside the window.
    const horizon = horizonInterval(now, 30)
    expect(horizon.start.toISOString()).toBe('2026-08-10T16:00:00.000Z')
    expect(toLocalDate(horizon.endExclusive)).toBe('2026-09-10')
  })

  it('includes a bill due later today and excludes one past the horizon', () => {
    const horizon = horizonInterval(now, 30)
    expect(contains(horizon, new Date('2026-08-11T14:00:00Z'))).toBe(true) // 22:00 HKT today
    expect(contains(horizon, fromLocalDate('2026-09-09'))).toBe(true)
    expect(contains(horizon, fromLocalDate('2026-09-10'))).toBe(false) // exclusive bound
  })

  it('supports a zero-day horizon as today only', () => {
    const horizon = horizonInterval(now, 0)
    expect(horizon.start.getTime()).toBe(horizon.endExclusive.getTime())
  })

  it('rejects a negative or fractional horizon', () => {
    expect(() => horizonInterval(now, -1)).toThrow(ClockError)
    expect(() => horizonInterval(now, 2.5)).toThrow(ClockError)
  })
})

describe('trailingMonthIntervals — smart_sort\'s multi-period average window', () => {
  it('returns the requested count of complete months, oldest first', () => {
    const now = new Date('2026-08-14T04:00:00Z') // mid-August
    const months = trailingMonthIntervals(now, 3)
    expect(months.map((m) => toLocalDate(m.start))).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ])
    expect(months.map((m) => toLocalDate(m.endExclusive))).toEqual([
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
    ])
  })

  it('excludes the current, in-progress month', () => {
    const now = new Date('2026-08-14T04:00:00Z')
    const months = trailingMonthIntervals(now, 1)
    expect(contains(months[0]!, now)).toBe(false)
  })

  it('rolls December of the prior year in correctly', () => {
    const now = new Date('2026-01-15T04:00:00Z')
    const months = trailingMonthIntervals(now, 1)
    expect(toLocalDate(months[0]!.start)).toBe('2025-12-01')
    expect(toLocalDate(months[0]!.endExclusive)).toBe('2026-01-01')
  })

  it('returns an empty array for a zero count, without throwing', () => {
    expect(trailingMonthIntervals(new Date('2026-08-14T04:00:00Z'), 0)).toEqual([])
  })

  it('rejects a negative or fractional count', () => {
    const now = new Date('2026-08-14T04:00:00Z')
    expect(() => trailingMonthIntervals(now, -1)).toThrow(ClockError)
    expect(() => trailingMonthIntervals(now, 2.5)).toThrow(ClockError)
  })
})

describe('module contract', () => {
  it('defaults to the app timezone', () => {
    expect(APP_TIMEZONE).toBe('Asia/Hong_Kong')
    const instant = new Date('2026-01-31T16:30:00Z')
    expect(toLocalDate(instant)).toBe(toLocalDate(instant, APP_TIMEZONE))
  })
})
