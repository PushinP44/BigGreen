import { zonedParts } from '@/lib/domain/clock'

/**
 * Display-only formatting shared across pages. Anything that decides what a
 * number *means* belongs in `lib/domain/`; this is only about how it is drawn.
 */

/**
 * `dd/mm` in the app timezone — the compact form used down a date column, where
 * the year is almost always obvious from context and would just add width.
 */
export function shortDate(date: Date): string {
  const parts = zonedParts(date)
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}`
}

/**
 * One minor-unit amount as a percentage of another, clamped to 0–100.
 *
 * Scales by 1000 before dividing so a bigint division does not truncate the
 * first decimal place away, then converts once at the end — the same
 * integer-first discipline as the rest of the money code, even though the
 * result here is only ever a bar width.
 */
export function percentOf(value: bigint, total: bigint): number {
  if (total <= 0n) return 0
  const raw = Number((value * 1000n) / total) / 10
  return Math.max(0, Math.min(100, raw))
}
