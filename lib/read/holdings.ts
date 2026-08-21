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
  percentChange,
  quantityToString,
  type HoldingEntrySnapshot,
} from '@/lib/domain/holdings'
import { daysBetween, fromLocalDate } from '@/lib/domain/clock'
import { isCurrency, type Currency } from '@/lib/domain/money'

export interface PricedHolding {
  readonly instrumentId: string
  readonly accountId: string
  /** The account's own name — "ZA Invest USD", not the `institution` key. */
  readonly accountName: string
  readonly symbol: string
  readonly currency: Currency
  /** Decimal string, e.g. "10.5000000000" — display formatting is the caller's job. */
  readonly quantity: string
  /** Null is `COST UNKNOWN` (PLAN §3) — never rendered as zero. */
  readonly avgCostMinor: bigint | null
  /** Total originally paid for the shares still held — `avgCostMinor` × quantity. Same nullability. */
  readonly costBasisMinor: bigint | null
  readonly priceMinor: bigint | null
  readonly priceAsOf: string | null
  /** Null when there is no price at all yet. */
  readonly marketValueMinor: bigint | null
  /** Null unless both cost and price are known. */
  readonly unrealizedPlMinor: bigint | null
  /** Same nullability as `unrealizedPlMinor` — a percent of an unknown P/L is equally unknown. */
  readonly unrealizedPlPercent: number | null
  /** Null when there is no price; PLAN's 7-trading-day staleness convention. */
  readonly staleDays: number | null
}

export async function loadHoldings(db: Db, now: Date): Promise<PricedHolding[]> {
  const [entryRows, instrumentRows, accountRows, priceRows] = await Promise.all([
    db.query<{ instrument_id: string; account_id: string; quantity_delta: string; amount_minor: string }>(`
      SELECT e.instrument_id, e.account_id, e.quantity_delta, e.amount_minor
        FROM entries e
        JOIN transactions t ON t.id = e.transaction_id
       WHERE e.instrument_id IS NOT NULL AND t.status = 'posted'
    `),
    db.query<{ id: string; symbol: string; currency: string }>(
      'SELECT id, symbol, currency FROM instruments',
    ),
    db.query<{ id: string; name: string }>('SELECT id, name FROM accounts'),
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
    accountId: row.account_id,
    quantityDelta: row.quantity_delta,
    amountMinor: BigInt(row.amount_minor),
  }))

  const instrumentById = new Map(instrumentRows.rows.map((row) => [row.id, row]))
  const accountById = new Map(accountRows.rows.map((row) => [row.id, row]))
  const priceById = new Map(priceRows.rows.map((row) => [row.instrument_id, row]))

  const priced: PricedHolding[] = []
  for (const holding of computeHoldings(holdingEntries)) {
    const instrument = instrumentById.get(holding.instrumentId)
    if (!instrument) continue // orphaned entry — should not happen, don't crash the dashboard over it

    const account = accountById.get(holding.accountId)
    if (!account) continue // same guard, for a position on an account that's since been removed

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
      accountId: holding.accountId,
      accountName: account.name,
      symbol: instrument.symbol,
      currency,
      quantity: quantityToString(holding.quantity),
      avgCostMinor: holding.avgCostMinor,
      costBasisMinor,
      priceMinor,
      priceAsOf,
      marketValueMinor,
      unrealizedPlMinor,
      unrealizedPlPercent: percentChange(costBasisMinor, marketValueMinor),
      staleDays: priceAsOf === null ? null : daysBetween(fromLocalDate(priceAsOf), now),
    })
  }

  return priced.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.accountName.localeCompare(b.accountName))
}

export interface RecentPosition {
  readonly transactionId: string
  readonly occurredAt: Date
  readonly description: string | null
  /** 'legacy' is told apart from 'buy' by its counterparty: Opening Equity, not the position's own account. */
  readonly mode: 'buy' | 'sell' | 'legacy'
  readonly symbol: string
  readonly accountName: string
  /** Signed decimal string — negative is a sell, same as the entry it came from. */
  readonly quantity: string
  readonly amountMinor: bigint
  readonly currency: Currency
}

/**
 * The last `limit` buy/sell/legacy transactions, newest first — what a
 * "remove this, I mis-typed it" flow needs to show. Never edited in place:
 * removing one sets `status = 'void'` (same convention as `/review`'s
 * discard), so the audit trail survives and `loadHoldings`'s `status =
 * 'posted'` filter drops it from every position/allocation figure on its own.
 *
 * Fetches every entry on each of the `limit` most-recent trade-touching
 * transactions (via the `recent` CTE) rather than filtering entries directly
 * with a bare `LIMIT` — the latter would cut a transaction off after just one
 * of its two legs, silently corrupting the mode/quantity derivation below.
 */
export async function listRecentPositions(db: Db, limit = 20): Promise<RecentPosition[]> {
  const legRows = await db.query<{
    transaction_id: string
    occurred_at: string
    description: string | null
    account_id: string
    instrument_id: string | null
    quantity_delta: string | null
    amount_minor: string
    currency: string
  }>(
    `WITH recent AS (
       SELECT DISTINCT t.id, t.occurred_at
         FROM transactions t
         JOIN entries e ON e.transaction_id = t.id
        WHERE t.status = 'posted' AND e.instrument_id IS NOT NULL
        ORDER BY t.occurred_at DESC
        LIMIT $1
     )
     SELECT e.transaction_id, r.occurred_at::text AS occurred_at, t.description,
            e.account_id, e.instrument_id, e.quantity_delta,
            e.amount_minor::text AS amount_minor, e.currency
       FROM entries e
       JOIN recent r ON r.id = e.transaction_id
       JOIN transactions t ON t.id = e.transaction_id
      ORDER BY r.occurred_at DESC`,
    [limit],
  )

  const [accountRows, instrumentRows] = await Promise.all([
    db.query<{ id: string; name: string; system_role: string | null }>(
      'SELECT id, name, system_role FROM accounts',
    ),
    db.query<{ id: string; symbol: string }>('SELECT id, symbol FROM instruments'),
  ])
  const accountById = new Map(accountRows.rows.map((row) => [row.id, row]))
  const symbolById = new Map(instrumentRows.rows.map((row) => [row.id, row.symbol]))

  const legsByTransaction = new Map<string, typeof legRows.rows>()
  for (const leg of legRows.rows) {
    const list = legsByTransaction.get(leg.transaction_id) ?? []
    list.push(leg)
    legsByTransaction.set(leg.transaction_id, list)
  }

  const positions: RecentPosition[] = []
  for (const legs of legsByTransaction.values()) {
    const instrumentLeg = legs.find((leg) => leg.instrument_id !== null && leg.quantity_delta !== null)
    if (!instrumentLeg?.instrument_id || !instrumentLeg.quantity_delta) continue

    const currency = instrumentLeg.currency.trim()
    if (!isCurrency(currency)) continue

    const symbol = symbolById.get(instrumentLeg.instrument_id)
    const account = accountById.get(instrumentLeg.account_id)
    if (!symbol || !account) continue // orphaned entry — should not happen, don't crash the page over it

    const cashLeg = legs.find((leg) => leg.instrument_id === null)
    const cashAccount = cashLeg ? accountById.get(cashLeg.account_id) : undefined
    const isSell = instrumentLeg.quantity_delta.startsWith('-')
    const mode: RecentPosition['mode'] = isSell
      ? 'sell'
      : cashAccount?.system_role === 'opening_equity'
        ? 'legacy'
        : 'buy'

    positions.push({
      transactionId: instrumentLeg.transaction_id,
      occurredAt: new Date(instrumentLeg.occurred_at),
      description: instrumentLeg.description,
      mode,
      symbol,
      accountName: account.name,
      quantity: instrumentLeg.quantity_delta,
      amountMinor: BigInt(instrumentLeg.amount_minor),
      currency,
    })
  }

  return positions.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
}
