/**
 * Small utilities shared by the per-sender parsers.
 *
 * Deliberately thin: each institution's label wording and layout differs
 * enough that a generic "labelled value" abstraction would hide more than it
 * saves. What's actually common across HSBC/ZA/Mox/KTB alerts is a handful of
 * primitives — an amount tagged with an ISO currency code, an explicit
 * offset date/time, cleaning up captured text — so that's all this exports.
 *
 * Pure: no I/O, no clock.
 */

import { isCurrency, parseAmountInput, type Currency, type Money } from '@/lib/domain/money'

/**
 * All real samples in hand write the currency as a plain 3-letter code
 * (`HKD18.00`, `USD 3.6100`) — never a symbol. `generic.ts` already covers
 * symbol variants as the fallback for anything a per-sender parser misses, so
 * this stays narrow rather than duplicating that list.
 */
const CURRENCY_AMOUNT = /(HKD|USD|THB)\s*([\d,]+(?:\.\d{1,2})?)(?!\d)(?!\.\d)/i

/**
 * Find an amount within `windowChars` of a label match. The label itself is
 * passed as a regex so callers can tolerate the label and its value landing
 * on the same line or on separate ones — real layout depends on how Gmail's
 * `getPlainBody()` flattens the source HTML table, which cannot be observed
 * without sending a live email through it, so every extraction here is
 * deliberately whitespace-tolerant rather than line-exact.
 */
export function findLabeledAmount(
  text: string,
  label: RegExp,
  windowChars = 80,
): Money | null {
  const labelMatch = label.exec(text)
  if (!labelMatch) return null

  const start = labelMatch.index + labelMatch[0].length
  const window = text.slice(start, start + windowChars)
  const amountMatch = CURRENCY_AMOUNT.exec(window)
  if (!amountMatch) return null

  const currency = amountMatch[1]!.toUpperCase()
  if (!isCurrency(currency)) return null

  try {
    return parseAmountInput(amountMatch[2]!, currency)
  } catch {
    // More decimals than the currency has, or otherwise unparseable — a
    // number we cannot represent exactly is not a number to record.
    return null
  }
}

/** Same shape, but starting the search from the label match's own start rather than requiring it first. */
export function findLabeledValue(text: string, label: RegExp, value: RegExp, windowChars = 80): string | null {
  const labelMatch = label.exec(text)
  if (!labelMatch) return null
  const start = labelMatch.index + labelMatch[0].length
  const window = text.slice(start, start + windowChars)
  return value.exec(window)?.[1]?.trim() ?? null
}

export function clean(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim().slice(0, 60)
}

/**
 * Construct a `Date` from local wall-clock fields at an explicit UTC offset.
 *
 * Every source here gives a *local* time (HKT, Bangkok) rather than UTC, and
 * `new Date(y, m, d, ...)` would silently apply the server's own timezone
 * instead. Explicit offset math is the only way this is right regardless of
 * where the code runs (PLAN D4 — date bucketing is Asia/Hong_Kong, never
 * whatever TZ the process happens to have).
 */
export function offsetDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetHours: number,
): Date | null {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  const sign = offsetHours >= 0 ? '+' : '-'
  const iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${sign}${pad(Math.trunc(Math.abs(offsetHours)))}:00`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

const MONTH_ABBR: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** "Apr" / "April" -> 4. Null for anything that isn't a recognisable English month name. */
export function monthIndex(name: string): number | null {
  return MONTH_ABBR[name.slice(0, 3).toLowerCase()] ?? null
}

export type { Currency, Money }
