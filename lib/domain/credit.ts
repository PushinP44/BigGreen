/**
 * Credit cards with a revolving balance.
 *
 * PLAN §5 originally modelled cards deliberately simply: the whole outstanding
 * balance counted as committed, no statement-cycle awareness. That is the right
 * conservative default for someone who clears the card monthly — it can
 * understate what you can spend but never overstate it.
 *
 * It is the wrong model for someone who carries a balance. Treating a
 * long-standing HK$40,000 balance as due within the next 30 days reports that
 * you have nothing available, every day, forever — and a safety rule that
 * always says UNSAFE is a safety rule you stop reading.
 *
 * So this module splits the card into the two things it actually is:
 *
 *   - a **near-term obligation** — the minimum payment due on the due date,
 *     which genuinely competes with your rent for the same cash; and
 *   - **debt** — the rest of the balance, which is not due this month but is
 *     costing you interest every day it exists.
 *
 * Liquidity counts the first. Net worth already counts the whole balance as a
 * liability, so nothing is hidden — and the interest estimate makes the price
 * of carrying it visible rather than leaving it to be discovered on a statement.
 *
 * Pure: no I/O, no clock. `now` is always an explicit argument.
 */

import { addDays, startOfDay, zonedParts, zonedTimeToInstant, APP_TIMEZONE } from './clock'
import type { EntrySnapshot } from './balances'

export class CreditError extends Error {
  override readonly name = 'CreditError'
}

export interface CreditCardTerms {
  /** Day of month the statement closes, 1–31. Clamped to short months. */
  readonly statementDay: number
  /** Day of month payment is due, 1–31. */
  readonly paymentDueDay: number
  readonly creditLimitMinor: bigint | null
  /** Annual rate in basis points. HK cards are commonly 3000–3600 (30–36%). */
  readonly aprBps: number | null
  /** Minimum payment as a fraction of the statement balance, in basis points. */
  readonly minPaymentPctBps: number
  /** Floor for the minimum payment — HK issuers typically set HK$50–250. */
  readonly minPaymentFloorMinor: bigint
}

export const DEFAULT_CARD_TERMS: CreditCardTerms = {
  statementDay: 1,
  paymentDueDay: 21,
  creditLimitMinor: null,
  aprBps: null,
  minPaymentPctBps: 100, // 1%
  minPaymentFloorMinor: 5_000n, // HK$50.00
}

// ── Statement cycle ─────────────────────────────────────────────────────────

export interface StatementCycle {
  /** Start of the most recently closed statement period. */
  readonly billedFrom: Date
  /** End of it, exclusive — everything before this is billed. */
  readonly closedAt: Date
  /** When that closed statement must be paid. */
  readonly dueAt: Date
  /** When the currently open period will close. */
  readonly nextCloseAt: Date
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Local midnight on `day` of the given month, clamped to the month's length.
 *
 * A statement day of 31 has to mean "the 31st, or the last day if there isn't
 * one" — otherwise February silently rolls into March and every cycle boundary
 * after it is wrong.
 */
function dayOfMonth(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const clamped = Math.min(Math.max(1, day), daysInMonth(year, month))
  return zonedTimeToInstant(
    { year, month, day: clamped, hour: 0, minute: 0, second: 0 },
    timeZone,
  )
}

function assertDay(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    throw new CreditError(`${label} must be a whole day of the month 1–31, got ${value}`)
  }
}

/**
 * Work out which statement is closed, when it is due, and when the open one
 * closes — all relative to `now`.
 */
export function statementCycle(
  now: Date,
  terms: CreditCardTerms,
  timeZone: string = APP_TIMEZONE,
): StatementCycle {
  assertDay(terms.statementDay, 'statementDay')
  assertDay(terms.paymentDueDay, 'paymentDueDay')

  const today = startOfDay(now, timeZone)
  const parts = zonedParts(now, timeZone)

  // The statement boundary in the current month may be ahead of or behind us.
  const thisMonthClose = dayOfMonth(parts.year, parts.month, terms.statementDay, timeZone)

  const closedAt =
    today.getTime() >= thisMonthClose.getTime()
      ? thisMonthClose
      : shiftMonths(parts.year, parts.month, -1, terms.statementDay, timeZone)

  const closedParts = zonedParts(closedAt, timeZone)
  const billedFrom = shiftMonths(
    closedParts.year,
    closedParts.month,
    -1,
    terms.statementDay,
    timeZone,
  )
  const nextCloseAt = shiftMonths(
    closedParts.year,
    closedParts.month,
    1,
    terms.statementDay,
    timeZone,
  )

  return {
    billedFrom,
    closedAt,
    dueAt: dueDateAfter(closedAt, terms.paymentDueDay, timeZone),
    nextCloseAt,
  }
}

function shiftMonths(
  year: number,
  month: number,
  delta: number,
  day: number,
  timeZone: string,
): Date {
  const total = (year * 12 + (month - 1)) + delta
  return dayOfMonth(Math.floor(total / 12), (total % 12) + 1, day, timeZone)
}

/**
 * The first occurrence of `paymentDueDay` strictly after the statement closed.
 *
 * Handles the common HK arrangement where the statement closes late in the
 * month and payment is due early the next — a due day *before* the statement
 * day simply lands in the following month rather than in the past.
 */
export function dueDateAfter(
  closedAt: Date,
  paymentDueDay: number,
  timeZone: string = APP_TIMEZONE,
): Date {
  const parts = zonedParts(closedAt, timeZone)
  const sameMonth = dayOfMonth(parts.year, parts.month, paymentDueDay, timeZone)
  if (sameMonth.getTime() > closedAt.getTime()) return sameMonth
  return shiftMonths(parts.year, parts.month, 1, paymentDueDay, timeZone)
}

// ── Balances ────────────────────────────────────────────────────────────────

/**
 * What you owe on the card, as a positive number.
 *
 * The ledger stores a card balance as negative (spending credits the
 * liability). Everything in this module works in positive "owed" terms, because
 * that is how a statement reads and how a person thinks about it.
 */
export function owedMinor(entries: readonly EntrySnapshot[], accountId: string): bigint {
  let total = 0n
  for (const entry of entries) {
    if (entry.accountId !== accountId) continue
    if (entry.status !== 'posted') continue
    total += entry.amountMinor
  }
  return total < 0n ? -total : 0n
}

/** What you owed when the last statement closed — the figure that is due. */
export function billedMinor(
  entries: readonly EntrySnapshot[],
  accountId: string,
  cycle: StatementCycle,
): bigint {
  let total = 0n
  for (const entry of entries) {
    if (entry.accountId !== accountId) continue
    if (entry.status !== 'posted') continue
    if (entry.occurredAt.getTime() >= cycle.closedAt.getTime()) continue
    total += entry.amountMinor
  }
  return total < 0n ? -total : 0n
}

/**
 * Spending since the statement closed — real debt, but next cycle's bill.
 *
 * Reported separately so the dashboard can show "you owe X, of which Y is due
 * on the 21st". Rolling them together is how people are surprised by a bill.
 */
export function unbilledMinor(
  entries: readonly EntrySnapshot[],
  accountId: string,
  cycle: StatementCycle,
): bigint {
  const owed = owedMinor(entries, accountId)
  const billed = billedMinor(entries, accountId, cycle)
  const unbilled = owed - billed
  return unbilled > 0n ? unbilled : 0n
}

// ── Obligations and cost ────────────────────────────────────────────────────

/**
 * The minimum you must pay by the due date.
 *
 * HK issuers generally charge a small percentage of the statement balance
 * subject to a floor. The floor never exceeds what you actually owe — a
 * HK$50 minimum on a HK$12 balance is HK$12.
 */
export function minimumPaymentMinor(billed: bigint, terms: CreditCardTerms): bigint {
  if (billed <= 0n) return 0n
  const percentage = (billed * BigInt(Math.max(0, terms.minPaymentPctBps))) / 10_000n
  const floor = terms.minPaymentFloorMinor
  const minimum = percentage > floor ? percentage : floor
  return minimum > billed ? billed : minimum
}

/**
 * Roughly what carrying this balance costs per month.
 *
 * Deliberately an estimate and labelled as one: real issuers compound daily,
 * charge from the transaction date once you revolve, and add fees this does not
 * know about. The number exists to make the price of the balance visible, not
 * to reconcile against a statement — the actual interest charge arrives as a
 * transaction like anything else.
 */
export function estimatedMonthlyInterestMinor(
  balanceOwed: bigint,
  aprBps: number | null,
): bigint | null {
  if (aprBps === null || aprBps <= 0) return null
  if (balanceOwed <= 0n) return 0n
  return (balanceOwed * BigInt(Math.round(aprBps))) / 10_000n / 12n
}

/** Headroom left on the card. Null when no limit has been recorded. */
export function availableCreditMinor(
  creditLimitMinor: bigint | null,
  owed: bigint,
): bigint | null {
  if (creditLimitMinor === null) return null
  const available = creditLimitMinor - owed
  return available > 0n ? available : 0n
}

export type CreditModel = 'minimum_payment' | 'full_balance'

export interface CardPosition {
  readonly accountId: string
  readonly owedMinor: bigint
  readonly billedMinor: bigint
  readonly unbilledMinor: bigint
  readonly minimumPaymentMinor: bigint
  readonly estimatedMonthlyInterestMinor: bigint | null
  readonly availableCreditMinor: bigint | null
  readonly cycle: StatementCycle
  /** What the safety rule should treat as committed, given the model. */
  readonly committedMinor: bigint
  /** True when the payment falls inside the safety rule's horizon. */
  readonly dueWithinHorizon: boolean
}

export interface CardPositionOptions {
  readonly terms: CreditCardTerms
  readonly model: CreditModel
  /** The safety rule's committed-outflow window, in days. */
  readonly horizonDays: number
  readonly timeZone?: string
}

/**
 * Everything the dashboard and the safety rule need about one card.
 *
 * `committedMinor` is the only value the safety rule consumes, and which value
 * that is depends on the model:
 *
 *   - `full_balance` — the whole thing, as before. Correct for someone who
 *     clears the card monthly, where the balance really is next month's outflow.
 *   - `minimum_payment` — only what must be paid by the due date, and only if
 *     that date falls inside the horizon. Correct for a revolver, where the
 *     balance is debt rather than an imminent payment.
 *
 * Under either model the full balance still reduces net worth, so choosing the
 * gentler one cannot make you look richer overall — only more liquid, which is
 * the truth.
 */
export function cardPosition(
  entries: readonly EntrySnapshot[],
  accountId: string,
  now: Date,
  options: CardPositionOptions,
): CardPosition {
  const timeZone = options.timeZone ?? APP_TIMEZONE
  const cycle = statementCycle(now, options.terms, timeZone)

  const owed = owedMinor(entries, accountId)
  const billed = billedMinor(entries, accountId, cycle)
  const unbilled = unbilledMinor(entries, accountId, cycle)
  const minimum = minimumPaymentMinor(billed, options.terms)

  const horizonEnd = addDays(startOfDay(now, timeZone), options.horizonDays, timeZone)
  const dueWithinHorizon = cycle.dueAt.getTime() < horizonEnd.getTime()

  const committed =
    options.model === 'full_balance' ? owed : dueWithinHorizon ? minimum : 0n

  return {
    accountId,
    owedMinor: owed,
    billedMinor: billed,
    unbilledMinor: unbilled,
    minimumPaymentMinor: minimum,
    estimatedMonthlyInterestMinor: estimatedMonthlyInterestMinor(owed, options.terms.aprBps),
    availableCreditMinor: availableCreditMinor(options.terms.creditLimitMinor, owed),
    cycle,
    committedMinor: committed,
    dueWithinHorizon,
  }
}
