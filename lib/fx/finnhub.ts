import 'server-only'

/**
 * Live equity prices from Finnhub's free `/quote` endpoint.
 *
 * PLAN §7.3/§13 originally kept equity prices manual by decision — no paid
 * provider, no real-time quotes, because a single-user HK-heavy portfolio
 * didn't justify the dependency. This reverses that decision on the owner's
 * instruction, reusing the exact integration this account already runs in
 * `Livin'` (`backend/app/services/stocks_service.py`): Finnhub's free quote
 * endpoint, one request per symbol, never let one bad symbol fail the batch.
 *
 * Same discipline as `frankfurter.ts`'s FX feed: never overwrites a manual
 * price for the same instrument and day, heartbeat-tracked via
 * `ingest_sources` so a dead feed is visible rather than looking like a quiet
 * market, injectable fetch for testing.
 */

import { z } from 'zod'
import type { Db } from '@/lib/db/client'
import { toLocalDate } from '@/lib/domain/clock'
import { isCurrency, minorUnitsOf, type Currency } from '@/lib/domain/money'

const QUOTE_URL = 'https://finnhub.io/api/v1/quote'

export const PRICES_SOURCE_KEY = 'prices:finnhub'

export class FinnhubError extends Error {
  override readonly name = 'FinnhubError'
}

const quoteSchema = z.object({
  c: z.number().nullable().optional(),
  pc: z.number().nullable().optional(),
})

export interface FetchedQuote {
  readonly symbol: string
  readonly priceMinor: bigint
}

export type FetchLike = (url: string) => Promise<Response>

/**
 * One quote for `symbol`, in `currency`'s minor units.
 *
 * Finnhub returns HTTP 200 with `c` and `pc` both zero/null for a symbol it
 * does not recognise, rather than an error status — treated as a thrown
 * failure here, not a real zero price. That is the exact guard the Python
 * service in `Livin'` already needed for the same reason.
 *
 * Assumes the quote is denominated in `currency` — true for the US-listed
 * symbols this feed is actually useful for (PLAN §7.1's institution survey
 * never found a live feed for HK-listed positions, and this does not change
 * that; an HK symbol Finnhub doesn't recognise simply fails per-symbol and
 * falls back to whatever manual price is on record).
 */
export async function fetchQuote(
  symbol: string,
  currency: Currency,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<FetchedQuote> {
  const url = `${QUOTE_URL}?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`
  const response = await fetchImpl(url)

  if (!response.ok) {
    throw new FinnhubError(`Finnhub returned ${response.status} for ${symbol}`)
  }

  const parsed = quoteSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new FinnhubError(`Finnhub returned an unexpected shape for ${symbol}`)
  }

  const current = parsed.data.c ?? 0
  const previousClose = parsed.data.pc ?? 0
  if (current === 0 && previousClose === 0) {
    throw new FinnhubError(`no quote data for symbol ${symbol} — Finnhub does not recognise it`)
  }
  if (current < 0) {
    throw new FinnhubError(`implausible price for ${symbol}: ${current}`)
  }

  const factor = 10 ** minorUnitsOf(currency)
  const priceMinor = BigInt(Math.round(current * factor))

  return { symbol, priceMinor }
}

export interface SyncPricesResult {
  readonly written: number
  readonly unchanged: number
  readonly failed: ReadonlyArray<{ symbol: string; reason: string }>
  readonly asOf: string
}

/**
 * Price every instrument the user holds, writing to `prices` with
 * `source='finnhub'`. One symbol failing (unrecognised, delisted, rate
 * limited) never blocks the rest — each is fetched independently and a
 * failure is recorded per-symbol rather than aborting the batch.
 */
export async function syncPrices(
  db: Db,
  now: Date,
  fetchImpl: FetchLike = fetch,
): Promise<SyncPricesResult> {
  const userId = await currentUserId(db)
  const apiKey = process.env.FINANCE_API_KEY

  if (!apiKey) {
    await touchHeartbeat(db, userId, { attempted: true, failed: true })
    throw new FinnhubError('FINANCE_API_KEY is not configured')
  }

  await touchHeartbeat(db, userId, { attempted: true })

  const instrumentsResult = await db.query<{ id: string; symbol: string; currency: string }>(
    'SELECT id, symbol, currency FROM instruments ORDER BY symbol',
  )
  const asOf = toLocalDate(now)

  const outcomes = await Promise.allSettled(
    instrumentsResult.rows.map(async (instrument) => {
      const currency = instrument.currency.trim()
      if (!isCurrency(currency)) {
        throw new FinnhubError(`${instrument.symbol} has unsupported currency ${currency}`)
      }
      const quote = await fetchQuote(instrument.symbol, currency, apiKey, fetchImpl)
      return { instrumentId: instrument.id, currency, priceMinor: quote.priceMinor }
    }),
  )

  let written = 0
  let unchanged = 0
  const failed: Array<{ symbol: string; reason: string }> = []

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i]!
    const symbol = instrumentsResult.rows[i]!.symbol

    if (outcome.status === 'rejected') {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : 'fetch failed'
      failed.push({ symbol, reason })
      continue
    }

    const { instrumentId, currency, priceMinor } = outcome.value
    // A manually-entered price for the same day is yours and stays — the feed
    // refreshes in place and never overwrites it, same rule as fx_rates.
    const result = await db.query(
      `INSERT INTO prices (user_id, instrument_id, as_of, close_minor, currency, source)
       VALUES ($1, $2, $3, $4, $5, 'finnhub')
       ON CONFLICT (user_id, instrument_id, as_of)
       DO UPDATE SET close_minor = EXCLUDED.close_minor
        WHERE prices.source <> 'manual'
          AND prices.close_minor IS DISTINCT FROM EXCLUDED.close_minor`,
      [userId, instrumentId, asOf, priceMinor.toString(), currency],
    )
    if ((result.affectedRows ?? 0) > 0) written += 1
    else unchanged += 1
  }

  // One bad symbol is a per-symbol failure, not a dead feed — only count the
  // heartbeat as failing when *nothing* could be priced, which is the signal
  // the key or the feed itself is broken rather than one unrecognised ticker.
  const allFailed = instrumentsResult.rows.length > 0 && failed.length === instrumentsResult.rows.length
  await touchHeartbeat(db, userId, { attempted: true, succeeded: !allFailed, failed: allFailed })

  return { written, unchanged, failed, asOf }
}

async function touchHeartbeat(
  db: Db,
  userId: string,
  state: { attempted?: boolean; succeeded?: boolean; failed?: boolean },
): Promise<void> {
  await db.query(
    `INSERT INTO ingest_sources
       (user_id, source_key, last_attempt_at, last_success_at,
        expected_interval_minutes, consecutive_failures)
     VALUES ($1, $2, now(), CASE WHEN $3 THEN now() ELSE NULL END, 1440, CASE WHEN $4 THEN 1 ELSE 0 END)
     ON CONFLICT (user_id, source_key) DO UPDATE SET
       last_attempt_at = now(),
       last_success_at = CASE WHEN $3 THEN now() ELSE ingest_sources.last_success_at END,
       consecutive_failures = CASE
         WHEN $3 THEN 0
         WHEN $4 THEN ingest_sources.consecutive_failures + 1
         ELSE ingest_sources.consecutive_failures
       END`,
    [userId, PRICES_SOURCE_KEY, state.succeeded ?? false, state.failed ?? false],
  )
}

async function currentUserId(db: Db): Promise<string> {
  const result = await db.query<{ uid: string | null }>('SELECT auth.uid() AS uid')
  const uid = result.rows[0]?.uid
  if (!uid) throw new Error('no authenticated user in session')
  return uid
}
