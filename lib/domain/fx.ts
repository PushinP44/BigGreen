/**
 * FX — rate conventions, validation, and the zero-sum balancing policy.
 *
 * PLAN.md §3 "FX rounding". The ledger requires every transaction's entries to
 * sum to exactly zero HKD, but each entry is converted and rounded
 * independently. Those two requirements are incompatible without an explicit
 * residual policy: convert three legs at NUMERIC(18,8), round each to minor
 * units, and they will not sum to zero. Without this module the deferred
 * constraint trigger fires at COMMIT on a perfectly legitimate transaction.
 *
 * Pure: no I/O, no clock.
 */

import {
  BASE_CURRENCY,
  convert,
  divRoundHalfEven,
  isRateOne,
  MoneyError,
  parseRate,
  RATE_ONE,
  RATE_SCALE,
  rateToString,
  type Currency,
  type Money,
  type Rate,
} from './money'

export class FxError extends Error {
  override readonly name = 'FxError'
}

/**
 * Standard FX notation: `base`/`quote` is the price of one `base` unit in
 * `quote` units. USD/HKD = 7.8 means one US dollar costs 7.8 Hong Kong dollars.
 *
 * Every rate this app stores has `quote = HKD`, so `rate` always answers
 * "what is one unit of this currency worth in HKD" — which is exactly the
 * number frozen onto an entry as `fx_rate_to_hkd` (PLAN D2).
 */
export interface FxRateRecord {
  readonly base: Currency
  readonly quote: Currency
  readonly asOf: string // YYYY-MM-DD, app-local
  readonly rate: Rate
  readonly source: string // 'manual' | 'frankfurter' | ...
}

/** Rates for one date, keyed by the currency being converted *from*. */
export type RateTable = Readonly<Partial<Record<Currency, FxRateRecord>>>

// ── Validation ──────────────────────────────────────────────────────────────
//
// PLAN §11: a feed returning garbage must fail the job, not silently reprice
// net worth. These bounds are deliberately wide — they catch a broken feed
// (zero, negative, off by 1000×), not a volatile market.

const MIN_PLAUSIBLE_RATE = parseRate('0.00000001')
const MAX_PLAUSIBLE_RATE = parseRate('100000')

/** Reject a rate that cannot be a real price at all. */
export function assertPlausibleRate(rate: Rate, context: string): void {
  if (rate.scaled <= 0n) {
    throw new FxError(`${context}: rate must be positive, got ${rateToString(rate)}`)
  }
  if (rate.scaled < MIN_PLAUSIBLE_RATE.scaled || rate.scaled > MAX_PLAUSIBLE_RATE.scaled) {
    throw new FxError(`${context}: rate ${rateToString(rate)} is outside the plausible band`)
  }
}

/**
 * Reject a new rate that moved impossibly far from the previous one.
 *
 * A daily reference rate moving more than this against HKD means the feed
 * changed units or broke, not that the market did. HKD is pegged to USD and THB
 * is managed, so the real daily range is a fraction of a percent.
 */
const MAX_DAILY_MOVE_PERCENT = 25n

export function assertRateContinuity(previous: Rate, next: Rate, context: string): void {
  assertPlausibleRate(previous, `${context} (previous)`)
  assertPlausibleRate(next, context)

  const delta = next.scaled > previous.scaled ? next.scaled - previous.scaled : previous.scaled - next.scaled
  const movePercent = (delta * 100n) / previous.scaled

  if (movePercent > MAX_DAILY_MOVE_PERCENT) {
    throw new FxError(
      `${context}: rate moved ${movePercent}% from ${rateToString(previous)} to ` +
        `${rateToString(next)}, which is past the ${MAX_DAILY_MOVE_PERCENT}% sanity bound. ` +
        `Treating this as a broken feed rather than a market move.`,
    )
  }
}

// ── Rate lookup ─────────────────────────────────────────────────────────────

/**
 * The rate to convert `currency` into HKD.
 *
 * HKD converts to itself at exactly 1 and never consults the table — a base
 * currency that depends on a feed is a base currency that can go missing.
 */
export function rateToBase(currency: Currency, table: RateTable): Rate {
  if (currency === BASE_CURRENCY) return RATE_ONE

  const record = table[currency]
  if (record === undefined) {
    throw new FxError(`no ${currency}/${BASE_CURRENCY} rate available`)
  }
  if (record.quote !== BASE_CURRENCY) {
    throw new FxError(
      `rate table entry for ${currency} quotes ${record.quote}, expected ${BASE_CURRENCY}`,
    )
  }
  assertPlausibleRate(record.rate, `${currency}/${BASE_CURRENCY}`)
  return record.rate
}

export function toBase(amount: Money, table: RateTable): Money {
  const rate = rateToBase(amount.currency, table)
  if (amount.currency === BASE_CURRENCY) return amount
  return convert(amount, BASE_CURRENCY, rate)
}

/** Invert a rate — `1 / rate`, half-even at the rate's own scale. */
export function invertRate(rate: Rate): Rate {
  assertPlausibleRate(rate, 'invertRate')
  const factor = 10n ** BigInt(RATE_SCALE)
  return { scaled: divRoundHalfEven(factor * factor, rate.scaled) }
}

// ── Balancing ───────────────────────────────────────────────────────────────

export interface EntryInput {
  readonly accountId: string
  readonly amountMinor: bigint
  readonly currency: Currency
  readonly fxRateToHkd: Rate
  readonly instrumentId?: string | null
  readonly quantityDelta?: string | null
}

export interface BalancedEntry extends EntryInput {
  readonly amountHkdMinor: bigint
  /** True for the synthetic entry that absorbs conversion rounding. */
  readonly isFxResidual: boolean
}

export interface BalanceResult {
  readonly entries: readonly BalancedEntry[]
  /** Zero for single-currency transactions, which is the common path. */
  readonly residualMinor: bigint
  /**
   * True when the residual was pure arithmetic (booked to `FX Rounding`), false
   * when it was a real economic spread (booked to `FX Gain/Loss`). Callers show
   * the second one to the user; the first is noise.
   */
  readonly isRounding: boolean
}

export interface BalanceOptions {
  /** Account id of the dedicated `FX Rounding` equity account. */
  readonly fxRoundingAccountId: string
  /**
   * Account id of the `FX Gain/Loss` expense account.
   *
   * Two different things can make converted legs fail to sum to zero, and
   * collapsing them would be a mistake:
   *
   *  - **Arithmetic residue** (≤1 minor unit per converted leg) from rounding
   *    each leg independently. Not money. Goes to `FX Rounding` automatically.
   *  - **Economic difference** — you moved 100 USD and 3,494 THB arrived,
   *    because the bank used its own rate with a spread. That gap is real money
   *    and belongs in an expense account you can actually see.
   *
   * Passing this opts into the second case. Flows that represent a genuine
   * cross-currency movement (the transfer flow) pass it deliberately; ordinary
   * spending does not, so an unbalanced single-currency transaction still
   * throws instead of quietly finding a home.
   */
  readonly fxGainLossAccountId?: string
}

/**
 * A spread beyond this fraction of the transaction is a typo, not a bank.
 * Real retail FX spreads are low single digits; a mistyped amount is usually
 * off by 10× or more.
 */
const MAX_SPREAD_PERCENT = 10n

/**
 * Convert every entry to HKD, then make the set sum to exactly zero.
 *
 * The residual is booked to a visible `FX Rounding` equity account rather than
 * being absorbed into one of the real legs. It is auditable, and its lifetime
 * total is a health metric — a residual account that grows fast means a rate is
 * wrong somewhere.
 *
 * Throws rather than absorbing when the imbalance is too large to be rounding.
 * That distinction is the whole value of this function: a 3-cent gap across
 * three converted legs is arithmetic, a 3-dollar gap is a caller bug, and
 * silently booking the second one to an equity account would hide it forever.
 */
export function balanceEntries(
  inputs: readonly EntryInput[],
  options: BalanceOptions,
): BalanceResult {
  if (inputs.length < 2) {
    throw new FxError(`a transaction needs at least 2 entries, got ${inputs.length}`)
  }

  const converted: BalancedEntry[] = inputs.map((input) => {
    if (input.currency === BASE_CURRENCY) {
      if (!isRateOne(input.fxRateToHkd)) {
        throw new FxError(
          `${BASE_CURRENCY} entry must carry rate 1, got ${rateToString(input.fxRateToHkd)}`,
        )
      }
      return { ...input, amountHkdMinor: input.amountMinor, isFxResidual: false }
    }

    assertPlausibleRate(input.fxRateToHkd, `${input.currency} entry`)
    let amountHkdMinor: bigint
    try {
      amountHkdMinor = convert(
        { amountMinor: input.amountMinor, currency: input.currency },
        BASE_CURRENCY,
        input.fxRateToHkd,
      ).amountMinor
    } catch (cause) {
      if (cause instanceof MoneyError) throw new FxError(cause.message)
      throw cause
    }
    return { ...input, amountHkdMinor, isFxResidual: false }
  })

  let residual = 0n
  for (const entry of converted) residual += entry.amountHkdMinor

  if (residual === 0n) {
    return { entries: converted, residualMinor: 0n, isRounding: true }
  }

  // Each converted leg can contribute at most half a minor unit of rounding
  // error, so the tolerance is one unit per converted leg. Unconverted HKD legs
  // contribute exactly nothing and must not buy the caller any slack.
  const convertedLegs = converted.filter((e) => e.currency !== BASE_CURRENCY).length
  const magnitude = residual < 0n ? -residual : residual

  if (convertedLegs === 0) {
    throw new FxError(
      `single-currency transaction does not balance: entries sum to ${residual} ` +
        `minor units instead of 0. This is a caller bug, not rounding.`,
    )
  }

  const isRounding = magnitude <= BigInt(convertedLegs)

  if (!isRounding && options.fxGainLossAccountId === undefined) {
    throw new FxError(
      `entries are out of balance by ${residual} minor units across ${convertedLegs} ` +
        `converted leg(s). Rounding can account for at most ${convertedLegs}. ` +
        `If this is a real FX spread, pass fxGainLossAccountId to book it explicitly; ` +
        `otherwise check the amounts and rates.`,
    )
  }

  if (!isRounding) {
    // Guard the opt-in too: a genuine spread is a small fraction of the amount
    // moved, so a large one means a mistyped amount, not an expensive bank.
    let gross = 0n
    for (const e of converted) {
      const m = e.amountHkdMinor < 0n ? -e.amountHkdMinor : e.amountHkdMinor
      if (m > gross) gross = m
    }
    if (gross > 0n && magnitude * 100n > gross * MAX_SPREAD_PERCENT) {
      throw new FxError(
        `FX difference of ${residual} minor units is more than ${MAX_SPREAD_PERCENT}% of the ` +
          `${gross}-minor-unit transaction. That is a typo, not a spread.`,
      )
    }
  }

  const residualEntry: BalancedEntry = {
    accountId: isRounding ? options.fxRoundingAccountId : options.fxGainLossAccountId!,
    amountMinor: -residual,
    currency: BASE_CURRENCY,
    fxRateToHkd: RATE_ONE,
    amountHkdMinor: -residual,
    isFxResidual: isRounding,
  }

  return { entries: [...converted, residualEntry], residualMinor: residual, isRounding }
}

/** Invariant check — the thing the database trigger also enforces. */
export function entriesSumToZero(entries: readonly BalancedEntry[]): boolean {
  let total = 0n
  for (const entry of entries) total += entry.amountHkdMinor
  return total === 0n
}
