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

import { divRoundHalfEven } from './money'

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

export interface HoldingEntrySnapshot {
  readonly instrumentId: string
  readonly quantityDelta: string // NUMERIC(28,10), as Postgres returns it
  /** Cost leg in the instrument's own currency. Zero for a legacy add with unknown cost. */
  readonly amountMinor: bigint
}

export interface HoldingResult {
  readonly instrumentId: string
  readonly quantity: Quantity
  /** Null when no leg carried a nonzero cost — `COST UNKNOWN`, never zero (PLAN §3). */
  readonly avgCostMinor: bigint | null
}

/**
 * One position per instrument, computed from every entry that touches it.
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

  for (const entry of entries) {
    const delta = parseQuantity(entry.quantityDelta)
    quantities.set(
      entry.instrumentId,
      addQuantity(quantities.get(entry.instrumentId) ?? ZERO_QUANTITY, delta),
    )

    if (entry.amountMinor !== 0n && delta.scaled > 0n) {
      const current = costTotals.get(entry.instrumentId) ?? {
        costMinor: 0n,
        costQuantity: ZERO_QUANTITY,
      }
      costTotals.set(entry.instrumentId, {
        costMinor: current.costMinor + entry.amountMinor,
        costQuantity: addQuantity(current.costQuantity, delta),
      })
    }
  }

  const results: HoldingResult[] = []
  for (const [instrumentId, quantity] of quantities) {
    if (quantity.scaled === 0n) continue // fully sold — nothing is held

    const cost = costTotals.get(instrumentId)
    const avgCostMinor =
      cost && cost.costQuantity.scaled > 0n
        ? divRoundHalfEven(cost.costMinor * QUANTITY_SCALE_FACTOR, cost.costQuantity.scaled)
        : null

    results.push({ instrumentId, quantity, avgCostMinor })
  }

  return results
}
