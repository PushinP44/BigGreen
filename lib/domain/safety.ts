/**
 * Safe / unsafe payment.
 *
 * The brief did not define this. PLAN §5 defines it as deterministic,
 * explainable and testable — three properties that matter more here than
 * sophistication, because a verdict you cannot interrogate gets ignored within
 * a week.
 *
 * Two things distinguish this from a naive affordability check:
 *
 *  - **Per currency pool.** THB in a Thai bank cannot buy lunch in Hong Kong,
 *    so a payment is judged against the money that can actually pay it. A
 *    blended figure would state that money is available today when it is days
 *    and a conversion spread away (PLAN rev 4).
 *  - **The floor is days of cover, not a constant.** `floor_days × daily_burn`
 *    self-calibrates as your life changes; a fixed cushion is a guess that goes
 *    stale in silence. It also produces a far more useful sentence: "leaves 41
 *    days of cover" rather than "leaves HK$39,751".
 *
 * Pure: takes a snapshot and an explicit `now`. No database, no clock, no I/O.
 */

import { addDays, contains, horizonInterval, monthInterval, type Interval } from './clock'
import type { AccountSnapshot, CategorySnapshot, EntrySnapshot } from './balances'
import {
  accountBalances,
  currencyPools,
  discretionarySpentInInterval,
  minorFactor,
  spentInCurrency,
  transactionDeltas,
  type CurrencyPool,
} from './balances'
import { BASE_CURRENCY, type Currency } from './money'

export type Verdict = 'SAFE' | 'CAUTION' | 'UNSAFE'

/** Per-pool knobs. A pool with no entry here gets no floor, which is honest. */
export interface PoolSettings {
  /** Days of cover to keep. 0 means "no floor, just don't overdraw". */
  readonly floorDays: number
  /**
   * Seed for the burn rate, in this pool's minor units per month, used until
   * the ledger has enough history to measure the real one.
   */
  readonly declaredMonthlySpendMinor: bigint
}

export interface SafetySettings {
  readonly pools: Readonly<Partial<Record<Currency, PoolSettings>>>
  /**
   * HKD per month, blended across every pool.
   *
   * The one place blending is correct, and the distinction matters: liquidity
   * is per pool because you cannot spend baht in Hong Kong, but a budget is
   * about behaviour — eating out in Bangkok is the same habit as eating out in
   * Kowloon, and a budget you could evade by crossing a border would measure
   * nothing.
   */
  readonly discretionaryBudgetHkdMinor: bigint
  readonly horizonDays: number
  /** Trailing window for the measured burn rate. */
  readonly burnWindowDays: number
  /** Below this much history, the declared burn is used instead. */
  readonly minHistoryDays: number
}

export const DEFAULT_SETTINGS: SafetySettings = {
  pools: {
    // Owner's stated spending is "under HK$8,000/month". The band ceiling is
    // used rather than its midpoint: a higher burn means a higher floor, and
    // this rule is allowed to understate what you can spend but never to
    // overstate it.
    HKD: { floorDays: 45, declaredMonthlySpendMinor: 800_000n },
    // USD reads as savings and THB as travel money, so neither carries a floor
    // by default. They still get a verdict — it just means "this would
    // overdraw you" rather than "this breaches your cushion".
    USD: { floorDays: 0, declaredMonthlySpendMinor: 0n },
    THB: { floorDays: 0, declaredMonthlySpendMinor: 0n },
  },
  discretionaryBudgetHkdMinor: 300_000n, // placeholder — owner sets this in Settings
  horizonDays: 30,
  burnWindowDays: 90,
  minHistoryDays: 30,
}

export interface SafetyInput {
  readonly accounts: readonly AccountSnapshot[]
  readonly entries: readonly EntrySnapshot[]
  readonly categories: readonly CategorySnapshot[]
  readonly settings: SafetySettings
  readonly now: Date
}

export type BurnSource = 'measured' | 'declared' | 'none'

/** The terms of the rule for one pool, exposed so the UI can show its working. */
export interface PoolTerms {
  readonly currency: Currency
  readonly liquidMinor: bigint
  readonly committedMinor: bigint
  readonly floorMinor: bigint
  readonly availableMinor: bigint
  /** Minor units per day. Zero when unknown, which disables runway. */
  readonly dailyBurnMinor: bigint
  readonly burnSource: BurnSource
  /** Days the un-floored balance would last. Null when the burn is unknown. */
  readonly runwayDays: number | null
  readonly floorDays: number
}

export interface SafetyTerms {
  readonly pools: readonly PoolTerms[]
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
  const pools = currencyPools(accounts, balances)
  const horizon = horizonInterval(now, settings.horizonDays)
  const historyDays = daysOfHistory(entries, now)

  return {
    pools: pools.map((pool) =>
      termsForPool(pool, accounts, entries, settings, now, horizon, historyDays),
    ),
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

function termsForPool(
  pool: CurrencyPool,
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  settings: SafetySettings,
  now: Date,
  horizon: Interval,
  historyDays: number,
): PoolTerms {
  const poolSettings = settings.pools[pool.currency]
  const poolAccounts = new Set(pool.accountIds)

  // Deliberately simple credit-card treatment (PLAN §5): the full outstanding
  // balance is committed, with no statement-cycle awareness. It may understate
  // `available`; it cannot overstate it — and overstating is the failure that
  // tells you you're rich when you aren't. The balance is negative in the
  // ledger, so negate it.
  const cardDebt = pool.liabilitiesMinor < 0n ? -pool.liabilitiesMinor : 0n

  const committed =
    cardDebt + scheduledExternalOutflows(accounts, entries, poolAccounts, pool.currency, horizon)

  const { dailyBurnMinor, burnSource } = burnRate(
    pool,
    accounts,
    entries,
    poolSettings,
    settings,
    now,
    historyDays,
  )

  const floorDays = poolSettings?.floorDays ?? 0
  const floor = dailyBurnMinor * BigInt(Math.max(0, Math.round(floorDays)))
  const spendable = pool.liquidMinor - committed

  return {
    currency: pool.currency,
    liquidMinor: pool.liquidMinor,
    committedMinor: committed,
    floorMinor: floor,
    availableMinor: spendable - floor,
    dailyBurnMinor,
    burnSource,
    runwayDays:
      dailyBurnMinor > 0n ? Number(spendable) / Number(dailyBurnMinor) : null,
    floorDays,
  }
}

/**
 * Declared until there is enough history, then measured.
 *
 * There is no spending history on day one, so a rule built on measured averages
 * cannot start. The declared figure bootstraps it; once the ledger holds
 * `minHistoryDays`, the trailing average takes over and the UI says which one
 * is in use. A number derived from real spending beats a guess — but only once
 * it exists.
 */
function burnRate(
  pool: CurrencyPool,
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  poolSettings: PoolSettings | undefined,
  settings: SafetySettings,
  now: Date,
  historyDays: number,
): { dailyBurnMinor: bigint; burnSource: BurnSource } {
  if (historyDays >= settings.minHistoryDays) {
    const windowDays = Math.max(1, Math.min(settings.burnWindowDays, historyDays))
    const window: Interval = {
      start: addDays(now, -windowDays),
      endExclusive: addDays(now, 1),
    }
    const spent = spentInCurrency(accounts, entries, pool.currency, window)
    const measured = spent / BigInt(windowDays)

    // A pool you genuinely do not spend from has a measured burn of zero, and
    // zero is the honest answer — it disables runway rather than inventing one.
    if (measured > 0n) return { dailyBurnMinor: measured, burnSource: 'measured' }
  }

  const declared = poolSettings?.declaredMonthlySpendMinor ?? 0n
  if (declared <= 0n) return { dailyBurnMinor: 0n, burnSource: 'none' }

  // 365/12 rather than 30, so a floor expressed in days does not drift by
  // ~1.4% against a figure the owner thinks of as monthly.
  return { dailyBurnMinor: (declared * 12n) / 365n, burnSource: 'declared' }
}

/** Days between the earliest recorded transaction and now. */
function daysOfHistory(entries: readonly EntrySnapshot[], now: Date): number {
  let earliest: number | null = null
  for (const entry of entries) {
    const time = entry.occurredAt.getTime()
    if (earliest === null || time < earliest) earliest = time
  }
  if (earliest === null) return 0
  return Math.max(0, Math.floor((now.getTime() - earliest) / 86_400_000))
}

/**
 * Scheduled money leaving this pool for the outside world within the horizon.
 *
 * Transfers between your own accounts never count. A scheduled credit card
 * payment settles a liability already counted in `cardDebt`; counting the
 * transfer too would double it. Grouping by transaction makes that fall out of
 * the arithmetic rather than needing a rule.
 */
function scheduledExternalOutflows(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  poolAccounts: ReadonlySet<string>,
  currency: Currency,
  horizon: Interval,
): bigint {
  const scheduled = entries
    .filter((entry) => entry.status === 'scheduled' && entry.currency === currency)
    .map((entry) => ({ ...entry, status: 'posted' as const }))

  // transactionDeltas measures movement across the boundary of everything you
  // own; restrict its inputs to this pool so a cross-currency transfer does not
  // read as an outflow here.
  const scoped = accounts.map((account) =>
    poolAccounts.has(account.id) ? account : { ...account, isOwn: false },
  )

  let total = 0n
  for (const delta of transactionDeltas(scoped, scheduled)) {
    if (!contains(horizon, delta.occurredAt)) continue
    if (delta.ownedDeltaHkdMinor < 0n) total += -delta.ownedDeltaHkdMinor
  }
  return total
}

// ── Verdict ─────────────────────────────────────────────────────────────────

export interface SafetyVerdict {
  readonly verdict: Verdict
  /**
   * Which term decided it, with the numbers. A red badge and nothing else gets
   * ignored within a week, so the reason is part of the return value rather
   * than something the UI reconstructs and gets subtly wrong.
   */
  readonly reason: string
  readonly currency: Currency
  readonly remainingMinor: bigint
  readonly shortfallMinor: bigint
  /** Runway after this payment. Null when the pool has no known burn rate. */
  readonly remainingRunwayDays: number | null
  readonly terms: PoolTerms
}

export interface ProposedPayment {
  readonly amountMinor: bigint
  readonly currency: Currency
  readonly isDiscretionary: boolean
  /** The payment converted to HKD, for the blended discretionary budget only. */
  readonly amountHkdMinor: bigint
}

export function poolTermsFor(
  terms: SafetyTerms,
  currency: Currency,
): PoolTerms | undefined {
  return terms.pools.find((pool) => pool.currency === currency)
}

export function evaluatePayment(
  terms: SafetyTerms,
  payment: ProposedPayment,
): SafetyVerdict | null {
  const pool = poolTermsFor(terms, payment.currency)
  if (!pool) return null

  const remaining = pool.availableMinor - payment.amountMinor
  const spendableAfter = pool.liquidMinor - pool.committedMinor - payment.amountMinor
  const remainingRunway =
    pool.dailyBurnMinor > 0n ? Number(spendableAfter) / Number(pool.dailyBurnMinor) : null

  if (payment.amountMinor > pool.availableMinor) {
    const shortfall = payment.amountMinor - pool.availableMinor
    return {
      verdict: 'UNSAFE',
      currency: pool.currency,
      reason:
        pool.availableMinor < 0n
          ? `You are already ${fmt(-pool.availableMinor, pool.currency)} past your ${pool.currency} limit before this payment.`
          : `${fmt(shortfall, pool.currency)} more than your ${pool.currency} allows. ` +
            describeTerms(pool),
      remainingMinor: remaining,
      shortfallMinor: shortfall,
      remainingRunwayDays: remainingRunway,
      terms: pool,
    }
  }

  if (payment.isDiscretionary) {
    const afterBudget = terms.discretionarySpentHkdMinor + payment.amountHkdMinor
    if (afterBudget > terms.discretionaryBudgetHkdMinor) {
      return {
        verdict: 'CAUTION',
        currency: pool.currency,
        reason:
          `Affordable, but it puts you ${fmt(afterBudget - terms.discretionaryBudgetHkdMinor, BASE_CURRENCY)} ` +
          `over your ${fmt(terms.discretionaryBudgetHkdMinor, BASE_CURRENCY)} discretionary budget this month.`,
        remainingMinor: remaining,
        shortfallMinor: 0n,
        remainingRunwayDays: remainingRunway,
        terms: pool,
      }
    }
  }

  return {
    verdict: 'SAFE',
    currency: pool.currency,
    reason:
      remainingRunway === null
        ? `Leaves ${fmt(remaining, pool.currency)} available.`
        : `Leaves ${fmt(remaining, pool.currency)} available — about ${Math.floor(remainingRunway)} days of cover.`,
    remainingMinor: remaining,
    shortfallMinor: 0n,
    remainingRunwayDays: remainingRunway,
    terms: pool,
  }
}

function describeTerms(pool: PoolTerms): string {
  const parts = [`${fmt(pool.liquidMinor, pool.currency)} liquid`]
  if (pool.committedMinor > 0n) {
    parts.push(`${fmt(pool.committedMinor, pool.currency)} committed`)
  }
  if (pool.floorMinor > 0n) {
    parts.push(`a ${pool.floorDays}-day floor of ${fmt(pool.floorMinor, pool.currency)}`)
  }
  return parts.length === 1
    ? `You have ${parts[0]}.`
    : `You have ${parts[0]}, less ${parts.slice(1).join(' and ')}.`
}

/** Convenience for callers that have a snapshot but no precomputed terms. */
export function evaluate(input: SafetyInput, payment: ProposedPayment): SafetyVerdict | null {
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

function fmt(amountMinor: bigint, currency: Currency): string {
  const factor = minorFactor(currency)
  const negative = amountMinor < 0n
  const abs = negative ? -amountMinor : amountMinor
  const whole = (abs / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = (abs % factor).toString().padStart(currency === 'HKD' ? 2 : 2, '0')
  const symbol = currency === 'HKD' ? 'HK$' : currency === 'USD' ? 'US$' : '฿'
  return `${negative ? '-' : ''}${symbol}${whole}.${fraction}`
}

// ── Serialisation ───────────────────────────────────────────────────────────
//
// Server→client props in Next.js are JSON, and `bigint` does not survive
// JSON.stringify. Terms are computed once on the server and rehydrated on the
// client so the `+` sheet can re-evaluate on every keystroke — the same pure
// function running in both places, rather than a second approximate copy of the
// rule living in the UI.

export interface PoolTermsJson {
  readonly currency: Currency
  readonly liquidMinor: string
  readonly committedMinor: string
  readonly floorMinor: string
  readonly availableMinor: string
  readonly dailyBurnMinor: string
  readonly burnSource: BurnSource
  readonly runwayDays: number | null
  readonly floorDays: number
}

export interface SafetyTermsJson {
  readonly pools: readonly PoolTermsJson[]
  readonly discretionarySpentHkdMinor: string
  readonly discretionaryBudgetHkdMinor: string
  readonly horizonStart: string
  readonly horizonEndExclusive: string
}

export function termsToJson(terms: SafetyTerms): SafetyTermsJson {
  return {
    pools: terms.pools.map((pool) => ({
      currency: pool.currency,
      liquidMinor: pool.liquidMinor.toString(),
      committedMinor: pool.committedMinor.toString(),
      floorMinor: pool.floorMinor.toString(),
      availableMinor: pool.availableMinor.toString(),
      dailyBurnMinor: pool.dailyBurnMinor.toString(),
      burnSource: pool.burnSource,
      runwayDays: pool.runwayDays,
      floorDays: pool.floorDays,
    })),
    discretionarySpentHkdMinor: terms.discretionarySpentHkdMinor.toString(),
    discretionaryBudgetHkdMinor: terms.discretionaryBudgetHkdMinor.toString(),
    horizonStart: terms.horizon.start.toISOString(),
    horizonEndExclusive: terms.horizon.endExclusive.toISOString(),
  }
}

export function termsFromJson(json: SafetyTermsJson): SafetyTerms {
  return {
    pools: json.pools.map((pool) => ({
      currency: pool.currency,
      liquidMinor: BigInt(pool.liquidMinor),
      committedMinor: BigInt(pool.committedMinor),
      floorMinor: BigInt(pool.floorMinor),
      availableMinor: BigInt(pool.availableMinor),
      dailyBurnMinor: BigInt(pool.dailyBurnMinor),
      burnSource: pool.burnSource,
      runwayDays: pool.runwayDays,
      floorDays: pool.floorDays,
    })),
    discretionarySpentHkdMinor: BigInt(json.discretionarySpentHkdMinor),
    discretionaryBudgetHkdMinor: BigInt(json.discretionaryBudgetHkdMinor),
    horizon: {
      start: new Date(json.horizonStart),
      endExclusive: new Date(json.horizonEndExclusive),
    },
  }
}
