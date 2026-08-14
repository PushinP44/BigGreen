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

// ── Splitting an accepted suggestion across weighted instruments ──────────
//
// A per-stock target weight (`instruments.target_weight_bps`) answers a
// different question than a rebalancing target: "of new invest-money, what
// share goes here" (the owner's chosen interpretation, tied to this rule
// rather than current holdings).

export interface WeightedTarget {
  readonly id: string
  readonly weightBps: number
}

export interface WeightedSplit {
  readonly id: string
  readonly amountMinor: bigint
}

/**
 * Split `totalMinor` across `targets` in proportion to their weight.
 *
 * Largest-remainder method: assign each target's floor share first, then
 * hand out the leftover minor units one at a time to whichever targets had
 * the largest fractional remainder. The split always sums to exactly
 * `totalMinor` — money is never created or silently dropped to rounding,
 * the same discipline as the FX-rounding residual policy (PLAN §3).
 *
 * `targets`' weights need not sum to 10,000 bps (100%) — the caller decides
 * what happens to the gap (PLAN's "unweighted remainder" falls back to the
 * single-account flow that predates weighting). This function only ever
 * distributes `totalMinor` itself; scaling it down to the weighted portion
 * of a larger suggestion is the caller's job.
 */
export function splitByWeight(
  totalMinor: bigint,
  targets: readonly WeightedTarget[],
): WeightedSplit[] {
  const positive = targets.filter((t) => t.weightBps > 0)
  const totalWeightBps = positive.reduce((sum, t) => sum + t.weightBps, 0)
  if (positive.length === 0 || totalWeightBps === 0 || totalMinor <= 0n) return []

  const denominator = BigInt(totalWeightBps)
  const shares = positive.map((t) => {
    const numerator = totalMinor * BigInt(t.weightBps)
    return { id: t.id, floor: numerator / denominator, remainder: numerator % denominator }
  })

  const distributed = shares.reduce((sum, s) => sum + s.floor, 0n)
  let leftover = totalMinor - distributed

  const byRemainderDesc = [...shares].sort((a, b) =>
    b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : 0,
  )

  const amounts = new Map(shares.map((s) => [s.id, s.floor]))
  for (const s of byRemainderDesc) {
    if (leftover <= 0n) break
    amounts.set(s.id, (amounts.get(s.id) ?? 0n) + 1n)
    leftover -= 1n
  }

  return positive.map((t) => ({ id: t.id, amountMinor: amounts.get(t.id) ?? 0n }))
}
