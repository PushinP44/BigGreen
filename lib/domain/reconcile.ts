/**
 * Reconciliation — matching a materialised commitment to the payment that
 * actually happened.
 *
 * `recurrences` materialise `scheduled` transactions 60 days ahead so the
 * safety rule can see them (PLAN §5). When you then enter the real payment,
 * both exist: `committed` counts the scheduled row AND monthly spend counts the
 * posted one. That is a silent, compounding error in the number the whole app
 * is built around, which is why this ships with the safety engine in P2 rather
 * than being treated as an ingest feature (PLAN §7.4).
 *
 * Pure: scoring and selection only. Deciding what to do with a match — void the
 * scheduled row, set `reconciled_with_id` — belongs to the caller.
 */

import { daysBetween } from './clock'

export interface ReconcileCandidate {
  readonly transactionId: string
  /** The owned account the money moved through. */
  readonly accountId: string
  /** Signed, from your side: negative for an outflow. */
  readonly amountHkdMinor: bigint
  readonly occurredAt: Date
  readonly merchant: string | null
  readonly description: string | null
}

export interface ReconcileOptions {
  /** How far apart a commitment and its payment may be. Default ±7 days. */
  readonly windowDays: number
  /**
   * Absolute amount gate. A utility bill is rarely the exact figure you
   * scheduled, so exact-match would reconcile almost nothing and leave every
   * month double-counted.
   */
  readonly amountToleranceHkdMinor: bigint
  /**
   * Additional gate as a fraction of the scheduled amount, so a large bill is
   * not held to the same absolute tolerance as a small one. The effective gate
   * is whichever of the two is larger.
   */
  readonly amountToleranceFraction: number
  /** Below this, propose rather than merge. */
  readonly autoMergeThreshold: number
}

export const DEFAULT_RECONCILE_OPTIONS: ReconcileOptions = {
  windowDays: 7,
  amountToleranceHkdMinor: 5_000n, // 50.00 HKD
  amountToleranceFraction: 0.02, // or 2%, whichever is larger
  autoMergeThreshold: 0.75,
}

/**
 * Relative difference at which the amount score reaches zero.
 *
 * Scored relatively rather than against the absolute tolerance: a HK$31
 * difference on an HK$8,000 electricity bill is 0.4% and entirely normal, but
 * measured against a flat HK$50 tolerance it looks like a 62% mismatch and
 * drops a perfectly good match below the auto-merge threshold. The same HK$31
 * on an HK$60 bill is 52% and genuinely suspicious — which relative scoring
 * captures and absolute scoring cannot.
 */
const AMOUNT_SCORE_ZERO_AT = 0.05

export interface Match {
  readonly scheduledId: string
  readonly postedId: string
  readonly score: number
  /** True when the score clears the threshold and the caller may merge silently. */
  readonly autoMerge: boolean
}

export interface ReconcileResult {
  readonly matches: readonly Match[]
  /** Scheduled rows with no candidate — still genuine commitments. */
  readonly unmatchedScheduled: readonly string[]
}

/**
 * Score a candidate pair in [0, 1], or null when they cannot be the same event.
 *
 * Account and direction are hard gates rather than weighted terms: a payment
 * from a different account, or in the opposite direction, is not a weak match
 * for this commitment — it is a different transaction, and scoring it as
 * "somewhat similar" is how a reconciler starts merging unrelated rows.
 */
export function scoreMatch(
  scheduled: ReconcileCandidate,
  posted: ReconcileCandidate,
  options: ReconcileOptions = DEFAULT_RECONCILE_OPTIONS,
): number | null {
  if (scheduled.accountId !== posted.accountId) return null
  if (signOf(scheduled.amountHkdMinor) !== signOf(posted.amountHkdMinor)) return null

  const days = Math.abs(daysBetween(scheduled.occurredAt, posted.occurredAt))
  if (days > options.windowDays) return null

  const magnitude = absOf(scheduled.amountHkdMinor)
  const difference = absDiff(scheduled.amountHkdMinor, posted.amountHkdMinor)

  const fractionalGate = BigInt(
    Math.round(Number(magnitude) * Math.max(0, options.amountToleranceFraction)),
  )
  const gate =
    fractionalGate > options.amountToleranceHkdMinor
      ? fractionalGate
      : options.amountToleranceHkdMinor
  if (difference > gate) return null

  // Exact amount is the strongest signal a bill was paid as scheduled, so this
  // carries the most weight — but scored against the size of the bill, not
  // against a flat tolerance. See AMOUNT_SCORE_ZERO_AT.
  const relative = magnitude === 0n ? 0 : Number(difference) / Number(magnitude)
  const amountScore = 1 - Math.min(1, relative / AMOUNT_SCORE_ZERO_AT)

  const dateScore = options.windowDays === 0 ? 1 : 1 - days / options.windowDays

  const textScore = similarity(
    scheduled.merchant ?? scheduled.description ?? '',
    posted.merchant ?? posted.description ?? '',
  )

  return round(0.5 * amountScore + 0.3 * dateScore + 0.2 * textScore)
}

/**
 * Greedy best-first assignment: take the highest-scoring pair, remove both, and
 * repeat.
 *
 * Each scheduled row matches at most one payment and vice versa — without that,
 * one payment could reconcile three months of the same recurring bill and quietly
 * erase two real commitments.
 */
export function reconcileScheduled(
  scheduled: readonly ReconcileCandidate[],
  posted: readonly ReconcileCandidate[],
  options: ReconcileOptions = DEFAULT_RECONCILE_OPTIONS,
): ReconcileResult {
  const pairs: Match[] = []

  for (const commitment of scheduled) {
    for (const payment of posted) {
      const score = scoreMatch(commitment, payment, options)
      if (score === null) continue
      pairs.push({
        scheduledId: commitment.transactionId,
        postedId: payment.transactionId,
        score,
        autoMerge: score >= options.autoMergeThreshold,
      })
    }
  }

  // Sort by score, then by id so equal scores resolve deterministically rather
  // than by whatever order the database happened to return.
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      a.scheduledId.localeCompare(b.scheduledId) ||
      a.postedId.localeCompare(b.postedId),
  )

  const usedScheduled = new Set<string>()
  const usedPosted = new Set<string>()
  const matches: Match[] = []

  for (const pair of pairs) {
    if (usedScheduled.has(pair.scheduledId) || usedPosted.has(pair.postedId)) continue
    usedScheduled.add(pair.scheduledId)
    usedPosted.add(pair.postedId)
    matches.push(pair)
  }

  return {
    matches,
    unmatchedScheduled: scheduled
      .map((s) => s.transactionId)
      .filter((id) => !usedScheduled.has(id)),
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function signOf(value: bigint): number {
  return value < 0n ? -1 : value > 0n ? 1 : 0
}

function absOf(value: bigint): bigint {
  return value < 0n ? -value : value
}

function absDiff(a: bigint, b: bigint): bigint {
  return absOf(a - b)
}

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000
}

/**
 * Token overlap (Jaccard), deliberately crude.
 *
 * Text is only 20% of the score and exists to break ties between two bills of
 * similar size in the same week. Anything cleverer would be a similarity metric
 * nobody can predict, on a signal that should not be deciding matches anyway.
 */
export function similarity(a: string, b: string): number {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1

  const union = left.size + right.size - shared
  return union === 0 ? 0 : shared / union
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/)
      .filter((token) => token.length > 1),
  )
}
