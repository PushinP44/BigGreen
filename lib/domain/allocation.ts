/**
 * Inflow allocation — PLAN §8, the "2,000 HKD → 30%" rule.
 *
 * *"Investment notice every time money enters more than 2000 HKD, 30% for
 * savings."* Resolved per-inflow rather than cumulative (a 40th coffee refund
 * must not fire), external inflows only (moving your own money between your
 * own accounts is not income — exactly what double-entry buys, PLAN D1), and
 * converted at the entry's own frozen rate rather than a fresh one.
 *
 * Pure: this function only computes the number. Idempotency (never firing
 * twice for the same transaction) is structural, enforced by the database's
 * `UNIQUE (trigger_transaction_id)` constraint — not this module's job.
 */

import { applyRate, type Rate } from './money'

export interface AllocationSettings {
  readonly thresholdHkdMinor: bigint
  readonly pct: Rate
}

export interface AllocationSuggestionAmount {
  readonly inflowHkdMinor: bigint
  readonly suggestedHkdMinor: bigint
}

/**
 * Whether an external inflow should suggest an allocation, and how much.
 *
 * `inflowHkdMinor` is the transaction's own owned-side delta in HKD — the
 * same figure `balances.transactionDeltas` computes, already positive by
 * construction for anything that qualifies (a transfer between your own
 * accounts nets to zero and never reaches this function meaningfully; see
 * `lib/ledger/record.ts`, which only evaluates this for the `income`
 * direction, whose counterparty is always the non-owned system Income
 * account).
 */
export function evaluateInflow(
  inflowHkdMinor: bigint,
  settings: AllocationSettings,
): AllocationSuggestionAmount | null {
  if (inflowHkdMinor < settings.thresholdHkdMinor) return null

  const suggested = applyRate({ amountMinor: inflowHkdMinor, currency: 'HKD' }, settings.pct)
  return { inflowHkdMinor, suggestedHkdMinor: suggested.amountMinor }
}
