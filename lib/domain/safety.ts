/**
 * Safe / unsafe payment.
 *
 * The brief did not define this. PLAN §5 defines it as deterministic,
 * explainable and testable — three properties that matter more here than
 * sophistication, because a verdict you cannot interrogate gets ignored within
 * a week.
 *
 * Pure: takes a snapshot and an explicit `now`, returns a verdict and the
 * numbers behind it. No database, no clock, no I/O.
 */

import { contains, horizonInterval, monthInterval, type Interval } from './clock'
import type { AccountSnapshot, CategorySnapshot, EntrySnapshot } from './balances'
import {
  accountBalances,
  discretionarySpentInInterval,
  transactionDeltas,
} from './balances'

export type Verdict = 'SAFE' | 'CAUTION' | 'UNSAFE'

export interface SafetySettings {
  /** Cash you refuse to go below. Default 10,000 HKD (PLAN §13.1 — a guess). */
  readonly emergencyFloorHkdMinor: bigint
  /** Default 6,000 HKD/month (also a guess until you say otherwise). */
  readonly discretionaryBudgetHkdMinor: bigint
  /** How far ahead committed outflows are counted. Default 30. */
  readonly horizonDays: number
}

export const DEFAULT_SETTINGS: SafetySettings = {
  emergencyFloorHkdMinor: 1_000_000n, // 10,000.00 HKD
  discretionaryBudgetHkdMinor: 600_000n, // 6,000.00 HKD
  horizonDays: 30,
}

export interface SafetyInput {
  readonly accounts: readonly AccountSnapshot[]
  readonly entries: readonly EntrySnapshot[]
  readonly categories: readonly CategorySnapshot[]
  readonly settings: SafetySettings
  readonly now: Date
}

/** The terms of the rule, exposed so the UI can show its working. */
export interface SafetyTerms {
  readonly liquidHkdMinor: bigint
  readonly committedHkdMinor: bigint
  readonly floorHkdMinor: bigint
  readonly availableHkdMinor: bigint
  readonly discretionarySpentHkdMinor: bigint
  readonly discretionaryBudgetHkdMinor: bigint
  readonly horizon: Interval
}

/**
 * Compute the standing terms once; a verdict for a proposed payment is then a
 * pure function of these plus the amount. Keeping the two apart is what lets
 * the `+` sheet re-evaluate on every keystroke without touching the database.
 */
export function safetyTerms(input: SafetyInput): SafetyTerms {
  const { accounts, entries, categories, settings, now } = input

  const balances = accountBalances(accounts, entries)
  const horizon = horizonInterval(now, settings.horizonDays)

  let liquid = 0n
  let cardDebt = 0n

  for (const account of accounts) {
    if (!account.isOwn) continue
    const hkd = balances.get(account.id)?.hkdMinor ?? 0n

    if (account.kind === 'credit_card') {
      // Deliberately simple (PLAN §5): the full outstanding balance is
      // committed, with no statement-cycle awareness. This can understate
      // `available` for someone who pays in full monthly; it cannot overstate
      // it — and overstating is the failure that tells you you're rich when
      // you aren't. The balance is negative in the ledger, so negate it.
      if (hkd < 0n) cardDebt += -hkd
      continue
    }

    if (account.isLiquid) liquid += hkd
  }

  const committed = cardDebt + scheduledExternalOutflows(accounts, entries, horizon)
  const floor = settings.emergencyFloorHkdMinor

  return {
    liquidHkdMinor: liquid,
    committedHkdMinor: committed,
    floorHkdMinor: floor,
    availableHkdMinor: liquid - committed - floor,
    discretionarySpentHkdMinor: discretionarySpentInInterval(
      accounts,
      entries,
      categories,
      monthInterval(now),
    ),
    discretionaryBudgetHkdMinor: settings.discretionaryBudgetHkdMinor,
    horizon,
  }
}

/**
 * Scheduled money leaving for the outside world within the horizon.
 *
 * Two exclusions that are easy to get wrong and expensive to get wrong:
 *
 *  - **Transfers between your own accounts never count.** A scheduled credit
 *    card payment settles a liability already counted in `cardDebt`; counting
 *    the transfer too would double it. Grouping by transaction makes this fall
 *    out of the arithmetic rather than needing a rule.
 *  - **Reconciled rows never count.** Once a materialised scheduled bill has
 *    been matched to the payment that actually happened, it is voided — and
 *    `counts()` in balances.ts already drops non-posted entries, so this
 *    function only sees genuinely-pending commitments.
 */
function scheduledExternalOutflows(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  horizon: Interval,
): bigint {
  const scheduled = entries.filter((entry) => entry.status === 'scheduled')

  // transactionDeltas only counts 'posted', so evaluate the scheduled set by
  // temporarily treating it as posted — same grouping logic, different slice.
  const asPosted = scheduled.map((entry) => ({ ...entry, status: 'posted' as const }))

  let total = 0n
  for (const delta of transactionDeltas(accounts, asPosted)) {
    if (!contains(horizon, delta.occurredAt)) continue
    if (delta.ownedDeltaHkdMinor < 0n) total += -delta.ownedDeltaHkdMinor
  }
  return total
}

// ── Verdict ─────────────────────────────────────────────────────────────────

export interface SafetyVerdict {
  readonly verdict: Verdict
  /**
   * Which term decided it. A red badge with no explanation gets ignored within
   * a week, so the reason is part of the return value rather than something the
   * UI reconstructs and gets subtly wrong.
   */
  readonly reason: string
  /** What this payment would leave you with. */
  readonly remainingHkdMinor: bigint
  readonly shortfallHkdMinor: bigint
  readonly terms: SafetyTerms
}

export interface ProposedPayment {
  readonly amountHkdMinor: bigint
  readonly isDiscretionary: boolean
}

export function evaluatePayment(
  terms: SafetyTerms,
  payment: ProposedPayment,
): SafetyVerdict {
  const { amountHkdMinor, isDiscretionary } = payment
  const remaining = terms.availableHkdMinor - amountHkdMinor

  if (amountHkdMinor > terms.availableHkdMinor) {
    const shortfall = amountHkdMinor - terms.availableHkdMinor
    return {
      verdict: 'UNSAFE',
      reason:
        terms.availableHkdMinor < 0n
          ? `You are already ${fmt(-terms.availableHkdMinor)} below your floor before this payment.`
          : `${fmt(shortfall)} more than you have available. ` +
            `Your ${fmt(terms.liquidHkdMinor)} liquid is reduced by ` +
            `${fmt(terms.committedHkdMinor)} committed and a ${fmt(terms.floorHkdMinor)} floor.`,
      remainingHkdMinor: remaining,
      shortfallHkdMinor: shortfall,
      terms,
    }
  }

  if (isDiscretionary) {
    const afterBudget = terms.discretionarySpentHkdMinor + amountHkdMinor
    if (afterBudget > terms.discretionaryBudgetHkdMinor) {
      return {
        verdict: 'CAUTION',
        reason:
          `Affordable, but it puts you ${fmt(afterBudget - terms.discretionaryBudgetHkdMinor)} ` +
          `over your ${fmt(terms.discretionaryBudgetHkdMinor)} discretionary budget this month.`,
        remainingHkdMinor: remaining,
        shortfallHkdMinor: 0n,
        terms,
      }
    }
  }

  return {
    verdict: 'SAFE',
    reason: `Leaves ${fmt(remaining)} available after your committed outflows and floor.`,
    remainingHkdMinor: remaining,
    shortfallHkdMinor: 0n,
    terms,
  }
}

/** Convenience for callers that have a snapshot but no precomputed terms. */
export function evaluate(input: SafetyInput, payment: ProposedPayment): SafetyVerdict {
  return evaluatePayment(safetyTerms(input), payment)
}

/**
 * Ordering used by the monotonicity property test: a larger payment can never
 * move the verdict toward safety.
 */
export const VERDICT_SEVERITY: Record<Verdict, number> = {
  SAFE: 0,
  CAUTION: 1,
  UNSAFE: 2,
}

// ── Serialisation ───────────────────────────────────────────────────────────
//
// Server→client props in Next.js are JSON, and `bigint` does not survive
// JSON.stringify. Terms are computed once on the server and rehydrated on the
// client so the `+` sheet can re-evaluate on every keystroke without a round
// trip — the same pure function running in both places, rather than a second
// approximate copy of the rule living in the UI.

export interface SafetyTermsJson {
  readonly liquidHkdMinor: string
  readonly committedHkdMinor: string
  readonly floorHkdMinor: string
  readonly availableHkdMinor: string
  readonly discretionarySpentHkdMinor: string
  readonly discretionaryBudgetHkdMinor: string
  readonly horizonStart: string
  readonly horizonEndExclusive: string
}

export function termsToJson(terms: SafetyTerms): SafetyTermsJson {
  return {
    liquidHkdMinor: terms.liquidHkdMinor.toString(),
    committedHkdMinor: terms.committedHkdMinor.toString(),
    floorHkdMinor: terms.floorHkdMinor.toString(),
    availableHkdMinor: terms.availableHkdMinor.toString(),
    discretionarySpentHkdMinor: terms.discretionarySpentHkdMinor.toString(),
    discretionaryBudgetHkdMinor: terms.discretionaryBudgetHkdMinor.toString(),
    horizonStart: terms.horizon.start.toISOString(),
    horizonEndExclusive: terms.horizon.endExclusive.toISOString(),
  }
}

export function termsFromJson(json: SafetyTermsJson): SafetyTerms {
  return {
    liquidHkdMinor: BigInt(json.liquidHkdMinor),
    committedHkdMinor: BigInt(json.committedHkdMinor),
    floorHkdMinor: BigInt(json.floorHkdMinor),
    availableHkdMinor: BigInt(json.availableHkdMinor),
    discretionarySpentHkdMinor: BigInt(json.discretionarySpentHkdMinor),
    discretionaryBudgetHkdMinor: BigInt(json.discretionaryBudgetHkdMinor),
    horizon: {
      start: new Date(json.horizonStart),
      endExclusive: new Date(json.horizonEndExclusive),
    },
  }
}

function fmt(amountHkdMinor: bigint): string {
  const negative = amountHkdMinor < 0n
  const abs = negative ? -amountHkdMinor : amountHkdMinor
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}HK$${whole}.${cents}`
}
