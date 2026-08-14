import 'server-only'

/**
 * Holdings read model — joins the derived positions from
 * `lib/domain/holdings.ts` with instrument metadata and the latest price on
 * record (manual or `finnhub`, whichever is newer). Query only; the
 * arithmetic lives in the domain module.
 */

import type { Db } from '@/lib/db/client'
import {
  computeHoldings,
  multiplyQuantityByPriceMinor,
  quantityToString,
  type HoldingEntrySnapshot,
} from '@/lib/domain/holdings'
import { daysBetween, fromLocalDate } from '@/lib/domain/clock'
import { isCurrency, type Currency } from '@/lib/domain/money'

export interface PricedHolding {
  readonly instrumentId: string
  readonly symbol: string
  readonly currency: Currency
  /** Decimal string, e.g. "10.5000000000" — display formatting is the caller's job. */
  readonly quantity: string
  /** Null is `COST UNKNOWN` (PLAN §3) — never rendered as zero. */
  readonly avgCostMinor: bigint | null
  readonly priceMinor: bigint | null
  readonly priceAsOf: string | null
  /** Null when there is no price at all yet. */
  readonly marketValueMinor: bigint | null
  /** Null unless both cost and price are known. */
  readonly unrealizedPlMinor: bigint | null
  /** Null when there is no price; PLAN's 7-trading-day staleness convention. */
  readonly staleDays: number | null
}

export async function loadHoldings(db: Db, now: Date): Promise<PricedHolding[]> {
  const [entryRows, instrumentRows, priceRows] = await Promise.all([
    db.query<{ instrument_id: string; quantity_delta: string; amount_minor: string }>(`
      SELECT e.instrument_id, e.quantity_delta, e.amount_minor
        FROM entries e
        JOIN transactions t ON t.id = e.transaction_id
       WHERE e.instrument_id IS NOT NULL AND t.status = 'posted'
    `),
    db.query<{ id: string; symbol: string; currency: string }>(
      'SELECT id, symbol, currency FROM instruments',
    ),
    // Latest price per instrument regardless of source — a fresher manual
    // entry should win over a stale finnhub row and vice versa.
    db.query<{ instrument_id: string; close_minor: string | number; as_of: string }>(`
      SELECT DISTINCT ON (instrument_id) instrument_id, close_minor, as_of::text AS as_of
        FROM prices
       ORDER BY instrument_id, as_of DESC
    `),
  ])

  const holdingEntries: HoldingEntrySnapshot[] = entryRows.rows.map((row) => ({
    instrumentId: row.instrument_id,
    quantityDelta: row.quantity_delta,
    amountMinor: BigInt(row.amount_minor),
  }))

  const instrumentById = new Map(instrumentRows.rows.map((row) => [row.id, row]))
  const priceById = new Map(priceRows.rows.map((row) => [row.instrument_id, row]))

  const priced: PricedHolding[] = []
  for (const holding of computeHoldings(holdingEntries)) {
    const instrument = instrumentById.get(holding.instrumentId)
    if (!instrument) continue // orphaned entry — should not happen, don't crash the dashboard over it

    const currency = instrument.currency.trim()
    if (!isCurrency(currency)) continue

    const priceRow = priceById.get(holding.instrumentId)
    const priceMinor = priceRow ? BigInt(String(priceRow.close_minor)) : null
    const priceAsOf = priceRow ? priceRow.as_of : null

    const marketValueMinor =
      priceMinor === null ? null : multiplyQuantityByPriceMinor(holding.quantity, priceMinor)
    const costBasisMinor =
      holding.avgCostMinor === null
        ? null
        : multiplyQuantityByPriceMinor(holding.quantity, holding.avgCostMinor)
    const unrealizedPlMinor =
      marketValueMinor !== null && costBasisMinor !== null ? marketValueMinor - costBasisMinor : null

    priced.push({
      instrumentId: holding.instrumentId,
      symbol: instrument.symbol,
      currency,
      quantity: quantityToString(holding.quantity),
      avgCostMinor: holding.avgCostMinor,
      priceMinor,
      priceAsOf,
      marketValueMinor,
      unrealizedPlMinor,
      staleDays: priceAsOf === null ? null : daysBetween(fromLocalDate(priceAsOf), now),
    })
  }

  return priced.sort((a, b) => a.symbol.localeCompare(b.symbol))
}
