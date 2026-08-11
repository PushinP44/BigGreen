/**
 * Clock — all date bucketing happens in the app timezone, never UTC.
 *
 * PLAN.md D4. "Today", "this month" and the committed-outflow horizon are
 * local-calendar concepts. Bucketing in UTC misfiles eight hours of spending
 * across every month boundary, and the discretionary budget is the first number
 * to go wrong. That bug is invisible until you reconcile a month, which is why
 * it gets its own module and its own tests.
 *
 * Pure: every function takes the instant and the zone explicitly. Nothing here
 * calls `new Date()` with no arguments — that is what makes the rules testable
 * and is a hard rule for everything under `lib/domain/`.
 */

export const APP_TIMEZONE = 'Asia/Hong_Kong'

export class ClockError extends Error {
  override readonly name = 'ClockError'
}

export interface ZonedParts {
  readonly year: number
  readonly month: number // 1-12
  readonly day: number // 1-31
  readonly hour: number // 0-23
  readonly minute: number
  readonly second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) return cached

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    throw new ClockError(`unknown timezone: ${JSON.stringify(timeZone)}`)
  }

  formatterCache.set(timeZone, formatter)
  return formatter
}

function assertValidInstant(instant: Date): void {
  if (Number.isNaN(instant.getTime())) {
    throw new ClockError('invalid Date passed to clock function')
  }
}

/** Wall-clock parts of `instant` as observed in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string = APP_TIMEZONE): ZonedParts {
  assertValidInstant(instant)
  const parts = formatterFor(timeZone).formatToParts(instant)

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)
    if (part === undefined) throw new ClockError(`missing ${type} in formatted parts`)
    return Number(part.value)
  }

  // `hourCycle: 'h23'` can still yield 24 for midnight in some ICU versions.
  const hour = read('hour')

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  }
}

/** Offset of `timeZone` at `instant`, in milliseconds east of UTC. */
export function zoneOffsetMs(instant: Date, timeZone: string = APP_TIMEZONE): number {
  const p = zonedParts(instant, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // Sub-second precision is not represented in the formatted parts, so strip it
  // from the instant before differencing.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * The UTC instant at which the given wall-clock time occurs in `timeZone`.
 *
 * Asia/Hong_Kong is a fixed UTC+8 with no daylight saving, so the second pass
 * below is a no-op today. It is here so the module stays correct if the app
 * timezone is ever changed to a DST zone — which is the sort of assumption that
 * is cheap to honour now and expensive to discover later.
 */
export function zonedTimeToInstant(parts: ZonedParts, timeZone: string = APP_TIMEZONE): Date {
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )

  const firstGuess = new Date(asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone))
  const refinedOffset = zoneOffsetMs(firstGuess, timeZone)
  return new Date(asIfUtc - refinedOffset)
}

// ── Buckets ─────────────────────────────────────────────────────────────────

export function startOfDay(instant: Date, timeZone: string = APP_TIMEZONE): Date {
  const p = zonedParts(instant, timeZone)
  return zonedTimeToInstant(
    { year: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  )
}

/** Exclusive upper bound — the first instant of the next local day. */
export function endOfDayExclusive(instant: Date, timeZone: string = APP_TIMEZONE): Date {
  return addDays(startOfDay(instant, timeZone), 1, timeZone)
}

export function startOfMonth(instant: Date, timeZone: string = APP_TIMEZONE): Date {
  const p = zonedParts(instant, timeZone)
  return zonedTimeToInstant(
    { year: p.year, month: p.month, day: 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  )
}

/** Exclusive upper bound — the first instant of the next local month. */
export function endOfMonthExclusive(instant: Date, timeZone: string = APP_TIMEZONE): Date {
  const p = zonedParts(instant, timeZone)
  const nextMonth = p.month === 12 ? 1 : p.month + 1
  const nextYear = p.month === 12 ? p.year + 1 : p.year
  return zonedTimeToInstant(
    { year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  )
}

/**
 * Add calendar days in the given zone, preserving local wall-clock time.
 * Not the same as adding 86400000ms once a DST zone is involved.
 */
export function addDays(instant: Date, days: number, timeZone: string = APP_TIMEZONE): Date {
  if (!Number.isInteger(days)) throw new ClockError(`days must be an integer, got ${days}`)

  const p = zonedParts(instant, timeZone)
  // Date.UTC normalises overflow (day 32 → next month), so no manual carry.
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days))

  return zonedTimeToInstant(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: p.hour,
      minute: p.minute,
      second: p.second,
    },
    timeZone,
  )
}

// ── Local date strings ──────────────────────────────────────────────────────
//
// `YYYY-MM-DD` in app-local time. This is the form used for DATE columns
// (`prices.as_of`, `fx_rates.as_of`) and for grouping in read models.

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export function toLocalDate(instant: Date, timeZone: string = APP_TIMEZONE): string {
  const p = zonedParts(instant, timeZone)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Midnight local time on the given date, as a UTC instant. */
export function fromLocalDate(date: string, timeZone: string = APP_TIMEZONE): Date {
  const match = LOCAL_DATE_PATTERN.exec(date)
  if (!match) throw new ClockError(`expected YYYY-MM-DD, got ${JSON.stringify(date)}`)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (month < 1 || month > 12) throw new ClockError(`month out of range in ${date}`)
  if (day < 1 || day > 31) throw new ClockError(`day out of range in ${date}`)

  const instant = zonedTimeToInstant(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    timeZone,
  )

  // Reject 2026-02-30 and friends rather than silently rolling into March.
  if (toLocalDate(instant, timeZone) !== date) {
    throw new ClockError(`no such date: ${date}`)
  }
  return instant
}

/** Whole local days from `from` to `to`, positive when `to` is later. */
export function daysBetween(from: Date, to: Date, timeZone: string = APP_TIMEZONE): number {
  const a = startOfDay(from, timeZone).getTime()
  const b = startOfDay(to, timeZone).getTime()
  return Math.round((b - a) / 86_400_000)
}

export function isSameLocalDay(a: Date, b: Date, timeZone: string = APP_TIMEZONE): boolean {
  return toLocalDate(a, timeZone) === toLocalDate(b, timeZone)
}

export function isSameLocalMonth(a: Date, b: Date, timeZone: string = APP_TIMEZONE): boolean {
  const pa = zonedParts(a, timeZone)
  const pb = zonedParts(b, timeZone)
  return pa.year === pb.year && pa.month === pb.month
}

/** Half-open interval `[start, end)` — the shape every read-model query uses. */
export interface Interval {
  readonly start: Date
  readonly endExclusive: Date
}

export function monthInterval(instant: Date, timeZone: string = APP_TIMEZONE): Interval {
  return {
    start: startOfMonth(instant, timeZone),
    endExclusive: endOfMonthExclusive(instant, timeZone),
  }
}

/** `[startOfToday, startOfToday + days)` — the committed-outflow horizon (§5). */
export function horizonInterval(
  now: Date,
  days: number,
  timeZone: string = APP_TIMEZONE,
): Interval {
  if (!Number.isInteger(days) || days < 0) {
    throw new ClockError(`horizon days must be a non-negative integer, got ${days}`)
  }
  const start = startOfDay(now, timeZone)
  return { start, endExclusive: addDays(start, days, timeZone) }
}

export function contains(interval: Interval, instant: Date): boolean {
  const t = instant.getTime()
  return t >= interval.start.getTime() && t < interval.endExclusive.getTime()
}
