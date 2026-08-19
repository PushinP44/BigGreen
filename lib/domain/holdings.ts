/**
 * Holdings — derived, never written (PLAN §3).
 *
 * A position is never stored directly: `quantity` and `avg_cost` are computed
 * from `entries` where `instrument_id` is set, buys and legacy adds positive,
 * sells negative. Two writers of the same number is guaranteed drift, so
 * there is exactly one — same reasoning as `holdings` being a SQL view rather
 * than a table.
 *
 * Pure: no I/O, no clock.
 */

import { divRoundHalfEven, minorUnitsOf, type Currency } from './money'

/**
 * `quantity_delta` is `NUMERIC(28,10)`, arriving from Postgres as a string.
 * Carried as a bigint scaled by 10^10 — the same fixed-point pattern as
 * `Rate` in `money.ts`, kept local rather than added there since this is the
 * only module that needs it.
 */
export const QUANTITY_SCALE = 10
const QUANTITY_SCALE_FACTOR = 10n ** BigInt(QUANTITY_SCALE)

export interface Quantity {
  readonly scaled: bigint
}

export const ZERO_QUANTITY: Quantity = { scaled: 0n }

export class HoldingsError extends Error {
  override readonly name = 'HoldingsError'
}

const QUANTITY_PATTERN = /^-?\d+(\.\d+)?$/

export function parseQuantity(input: string): Quantity {
  const trimmed = input.trim()
  if (!QUANTITY_PATTERN.test(trimmed)) {
    throw new HoldingsError(`invalid quantity: ${JSON.stringify(input)}`)
  }

  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [whole = '0', fraction = ''] = unsigned.split('.')

  const padded = fraction.padEnd(QUANTITY_SCALE, '0').slice(0, QUANTITY_SCALE)
  const scaled = BigInt(whole) * QUANTITY_SCALE_FACTOR + BigInt(padded === '' ? '0' : padded)

  return { scaled: negative ? -scaled : scaled }
}

export function quantityToString(q: Quantity): string {
  const negative = q.scaled < 0n
  const a = negative ? -q.scaled : q.scaled
  const whole = a / QUANTITY_SCALE_FACTOR
  const fraction = (a % QUANTITY_SCALE_FACTOR).toString().padStart(QUANTITY_SCALE, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

function addQuantity(a: Quantity, b: Quantity): Quantity {
  return { scaled: a.scaled + b.scaled }
}

/**
 * Quantity × a per-share minor-unit price, half-even. Used for both market
 * value (price) and cost basis (avg cost) — the same operation either way.
 */
export function multiplyQuantityByPriceMinor(quantity: Quantity, priceMinor: bigint): bigint {
  return divRoundHalfEven(quantity.scaled * priceMinor, QUANTITY_SCALE_FACTOR)
}

const DECIMAL_STRING = /^\d+(\.\d+)?$/

function decimalDigits(input: string): { digits: bigint; decimals: number } {
  const trimmed = input.trim()
  if (!DECIMAL_STRING.test(trimmed)) {
    throw new HoldingsError(`invalid decimal: ${JSON.stringify(input)}`)
  }
  const [whole = '0', fraction = ''] = trimmed.split('.')
  return { digits: BigInt(whole + fraction), decimals: fraction.length }
}

/**
 * Quantity × a per-unit price quoted with *more* precision than the trade's
 * own currency — the shape a trade confirmation email gives when it states a
 * price per share/unit but not the total (ZA's buy-order alerts do this;
 * fund unit prices commonly run to 4 decimal places, e.g. `HKD11.2554`,
 * which is not itself representable as whole cents).
 *
 * Both inputs are taken as exact decimal strings — never floats — and
 * multiplied as integers, only rounding once, at the very end, down to the
 * target currency's minor unit (half-even, same as every other rounding
 * point in this codebase). This is the one general-purpose sibling to
 * `multiplyQuantityByPriceMinor` above; that one assumes the price is
 * already a whole number of minor units, which a quoted trade price often
 * is not.
 */
export function priceToAmountMinor(quantity: string, pricePerUnit: string, currency: Currency): bigint {
  const q = decimalDigits(quantity)
  const p = decimalDigits(pricePerUnit)
  const product = q.digits * p.digits
  const totalDecimals = q.decimals + p.decimals
  const targetDecimals = minorUnitsOf(currency)

  const shift = totalDecimals - targetDecimals
  if (shift <= 0) return product * 10n ** BigInt(-shift)
  return divRoundHalfEven(product, 10n ** BigInt(shift))
}

/**
 * Percent change of current value against what was originally paid, e.g.
 * `12.5` for a 12.5% gain, `-8` for an 8% loss. Null whenever either side is
 * unknown or the cost basis is exactly zero — a percentage built on an
 * unknown or zero base is exactly as fabricated as the COST UNKNOWN P/L it is
 * derived from (PLAN §3), so it stays null rather than reading as 0% or
 * Infinity.
 *
 * A plain `number` rather than a scaled bigint: this is a display-only ratio
 * between two minor-unit amounts in the same currency, never summed, stored,
 * or compared for equality — unlike a `Money` value, so `money.ts`'s
 * never-a-float rule does not apply to it.
 */
export function percentChange(
  costBasisMinor: bigint | null,
  currentValueMinor: bigint | null,
): number | null {
  if (costBasisMinor === null || currentValueMinor === null || costBasisMinor === 0n) return null
  return (Number(currentValueMinor - costBasisMinor) / Number(costBasisMinor)) * 100
}

export interface AllocationInput {
  readonly instrumentId: string
  readonly accountId: string
  /** Market value blended to HKD by the caller. Null means no live price yet. */
  readonly valueHkdMinor: bigint | null
}

export interface AllocationShare {
  readonly instrumentId: string
  readonly accountId: string
  readonly valueHkdMinor: bigint
  readonly percent: number
}

/**
 * Each position's share of total portfolio value, blended to HKD — the one
 * deliberate place positions are compared across currencies, since
 * concentration risk does not care what currency a position happens to be
 * priced in. This is unlike the pool cards and net-worth chart, which never
 * blend currencies on purpose (PLAN rev 4) because those answer "what can I
 * spend"; this answers "how much of what I hold is this one position."
 *
 * A position with no live price yet is excluded from both the numerator and
 * the denominator, not counted as zero — otherwise one stale price would
 * silently shrink every OTHER position's percentage instead of shrinking the
 * total. Same display-only-ratio convention as `percentChange`: a plain
 * `number`, never summed, stored, or compared for equality.
 */
export function computeAllocations(positions: readonly AllocationInput[]): AllocationShare[] {
  const priced = positions.filter(
    (p): p is AllocationInput & { valueHkdMinor: bigint } => p.valueHkdMinor !== null,
  )
  const total = priced.reduce((sum, p) => sum + p.valueHkdMinor, 0n)

  return priced.map((p) => ({
    instrumentId: p.instrumentId,
    accountId: p.accountId,
    valueHkdMinor: p.valueHkdMinor,
    percent: total > 0n ? (Number(p.valueHkdMinor) / Number(total)) * 100 : 0,
  }))
}

export interface HoldingEntrySnapshot {
  readonly instrumentId: string
  /** Which account holds this leg — GRAB in ZA and GRAB in IBKR are different positions. */
  readonly accountId: string
  readonly quantityDelta: string // NUMERIC(28,10), as Postgres returns it
  /** Cost leg in the instrument's own currency. Zero for a legacy add with unknown cost. */
  readonly amountMinor: bigint
}

export interface HoldingResult {
  readonly instrumentId: string
  readonly accountId: string
  readonly quantity: Quantity
  /** Null when no leg carried a nonzero cost — `COST UNKNOWN`, never zero (PLAN §3). */
  readonly avgCostMinor: bigint | null
}

/** `Map`/grouping key — the same instrument in two different accounts is two positions, not one. */
function positionKey(instrumentId: string, accountId: string): string {
  return `${instrumentId}:${accountId}`
}

/**
 * One position per (instrument, account) pair, computed from every entry
 * that touches it. The same instrument held in two different accounts — the
 * same stock at two different brokers — is two independent positions, never
 * merged into one number that hides which account it's actually sitting in.
 * Positions netted to exactly zero are omitted — nothing is held.
 *
 * `avgCost` is built only from legs carrying a nonzero `amountMinor` *and* a
 * positive quantity — a legacy position entered with unknown cost is a
 * zero-amount, nonzero-quantity leg (quantity moves, cost basis doesn't),
 * which is what keeps `avgCost` correctly nullable without corrupting it
 * toward zero. A sell's negative quantity is excluded from the cost-basis sum
 * entirely, not subtracted from it: average cost describes what you paid for
 * the shares you still hold, and netting a sale into that sum would drag the
 * average toward zero with every sale, which is not what the term means.
 */
export function computeHoldings(entries: readonly HoldingEntrySnapshot[]): HoldingResult[] {
  const quantities = new Map<string, Quantity>()
  const costTotals = new Map<string, { costMinor: bigint; costQuantity: Quantity }>()
  const identity = new Map<string, { instrumentId: string; accountId: string }>()

  for (const entry of entries) {
    const key = positionKey(entry.instrumentId, entry.accountId)
    identity.set(key, { instrumentId: entry.instrumentId, accountId: entry.accountId })

    const delta = parseQuantity(entry.quantityDelta)
    quantities.set(key, addQuantity(quantities.get(key) ?? ZERO_QUANTITY, delta))

    if (entry.amountMinor !== 0n && delta.scaled > 0n) {
      const current = costTotals.get(key) ?? {
        costMinor: 0n,
        costQuantity: ZERO_QUANTITY,
      }
      costTotals.set(key, {
        costMinor: current.costMinor + entry.amountMinor,
        costQuantity: addQuantity(current.costQuantity, delta),
      })
    }
  }

  const results: HoldingResult[] = []
  for (const [key, quantity] of quantities) {
    if (quantity.scaled === 0n) continue // fully sold — nothing is held

    const cost = costTotals.get(key)
    const avgCostMinor =
      cost && cost.costQuantity.scaled > 0n
        ? divRoundHalfEven(cost.costMinor * QUANTITY_SCALE_FACTOR, cost.costQuantity.scaled)
        : null

    const { instrumentId, accountId } = identity.get(key)!
    results.push({ instrumentId, accountId, quantity, avgCostMinor })
  }

  return results
}
