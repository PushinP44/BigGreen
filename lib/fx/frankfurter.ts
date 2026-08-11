import 'server-only'

/**
 * FX rates from Frankfurter (ECB reference rates).
 *
 * PLAN §7.3 — the one automatic data feed that survived the rev 3 simplicity
 * cut, because it is free, needs no key or account, and manual entry across
 * three currencies would be genuinely tedious.
 *
 * Two things this deliberately does not do:
 *
 *  - It never invents a rate. ECB publishes on business days only; a weekend
 *    transaction uses the last published rate and records which date it came
 *    from, rather than interpolating something that was never quoted.
 *  - It never overwrites a manual rate. If you moved THB at a rate materially
 *    different from the reference, yours is the truth (PLAN §7.3).
 */

import { z } from 'zod'
import type { Db } from '@/lib/db/client'
import {
  assertPlausibleRate,
  assertRateContinuity,
  FxError,
} from '@/lib/domain/fx'
import { BASE_CURRENCY, parseRate, rateToString, type Currency } from '@/lib/domain/money'

const API_ROOT = 'https://api.frankfurter.app'

/** Currencies we hold that are not the base (PLAN §13). */
export const TRACKED_CURRENCIES: readonly Currency[] = ['USD', 'THB']

export const FX_SOURCE_KEY = 'fx:frankfurter'

const responseSchema = z.object({
  amount: z.number(),
  base: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rates: z.record(z.string(), z.number()),
})

export interface FetchedRate {
  readonly base: Currency
  readonly quote: Currency
  readonly asOf: string
  readonly rateText: string
}

export type FetchLike = (url: string) => Promise<Response>

/**
 * One request per base currency, in the direction we actually store.
 *
 * Asking for HKD→{USD,THB} and inverting would be one fewer request but would
 * round twice — once at the API and once at inversion — for no benefit.
 */
export async function fetchRates(
  currencies: readonly Currency[] = TRACKED_CURRENCIES,
  fetchImpl: FetchLike = fetch,
): Promise<FetchedRate[]> {
  const results: FetchedRate[] = []

  for (const base of currencies) {
    if (base === BASE_CURRENCY) continue

    const url = `${API_ROOT}/latest?from=${base}&to=${BASE_CURRENCY}`
    const response = await fetchImpl(url)

    if (!response.ok) {
      throw new FxError(`Frankfurter returned ${response.status} for ${base}/${BASE_CURRENCY}`)
    }

    const parsed = responseSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new FxError(`Frankfurter returned an unexpected shape for ${base}/${BASE_CURRENCY}`)
    }

    const value = parsed.data.rates[BASE_CURRENCY]
    if (value === undefined) {
      throw new FxError(`Frankfurter response for ${base} has no ${BASE_CURRENCY} rate`)
    }
    if (parsed.data.amount !== 1) {
      throw new FxError(`expected a unit quote for ${base}, got amount ${parsed.data.amount}`)
    }

    // Cross the JSON-number boundary exactly once, here, and immediately into
    // a fixed-scale decimal string. Nothing downstream sees a float.
    const rateText = value.toFixed(8)
    assertPlausibleRate(parseRate(rateText), `${base}/${BASE_CURRENCY}`)

    results.push({
      base,
      quote: BASE_CURRENCY,
      asOf: parsed.data.date,
      rateText,
    })
  }

  return results
}

export interface SyncResult {
  readonly written: number
  readonly unchanged: number
  readonly rejected: Array<{ currency: Currency; reason: string }>
  readonly asOf: string | null
}

/**
 * Fetch and store, validating each rate against the last one we accepted.
 *
 * A rate that fails continuity is rejected rather than written — a feed that
 * changed units would otherwise silently reprice your entire net worth
 * (PLAN §11). Failures are recorded on the heartbeat so a dead feed is visible
 * on the dashboard rather than looking like a quiet market.
 */
export async function syncRates(
  db: Db,
  fetchImpl: FetchLike = fetch,
): Promise<SyncResult> {
  const userId = await currentUserId(db)
  await touchHeartbeat(db, userId, { attempted: true })

  let fetched: FetchedRate[]
  try {
    fetched = await fetchRates(TRACKED_CURRENCIES, fetchImpl)
  } catch (error) {
    await touchHeartbeat(db, userId, { attempted: true, failed: true })
    throw error
  }

  let written = 0
  let unchanged = 0
  const rejected: Array<{ currency: Currency; reason: string }> = []
  let asOf: string | null = null

  for (const rate of fetched) {
    asOf = rate.asOf

    const previous = await db.query<{ rate: string; source: string }>(
      `SELECT rate, source FROM fx_rates
        WHERE base = $1 AND quote = $2 AND as_of < $3
        ORDER BY as_of DESC LIMIT 1`,
      [rate.base, rate.quote, rate.asOf],
    )

    const prior = previous.rows[0]
    if (prior) {
      try {
        assertRateContinuity(parseRate(prior.rate), parseRate(rate.rateText), `${rate.base}/${rate.quote}`)
      } catch (error) {
        rejected.push({
          currency: rate.base,
          reason: error instanceof Error ? error.message : 'failed continuity check',
        })
        continue
      }
    }

    // A manually-entered rate for the same day is yours and stays. Everything
    // else is refreshed in place, so re-running the job is a no-op.
    const result = await db.query(
      `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
       VALUES ($1, $2, $3, $4, $5, 'frankfurter')
       ON CONFLICT (user_id, base, quote, as_of)
       DO UPDATE SET rate = EXCLUDED.rate
        WHERE fx_rates.source <> 'manual'
          AND fx_rates.rate IS DISTINCT FROM EXCLUDED.rate`,
      [userId, rate.base, rate.quote, rate.asOf, rate.rateText],
    )

    if ((result.affectedRows ?? 0) > 0) written += 1
    else unchanged += 1
  }

  await touchHeartbeat(db, userId, { attempted: true, succeeded: rejected.length === 0 })

  return { written, unchanged, rejected, asOf }
}

/** Manual override — always wins over the feed. */
export async function setManualRate(
  db: Db,
  base: Currency,
  asOf: string,
  rateText: string,
): Promise<void> {
  const rate = parseRate(rateText)
  assertPlausibleRate(rate, `${base}/${BASE_CURRENCY} (manual)`)

  const userId = await currentUserId(db)
  await db.query(
    `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
     VALUES ($1, $2, $3, $4, $5, 'manual')
     ON CONFLICT (user_id, base, quote, as_of)
     DO UPDATE SET rate = EXCLUDED.rate, source = 'manual'`,
    [userId, base, BASE_CURRENCY, asOf, rateToString(rate)],
  )
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
    [userId, FX_SOURCE_KEY, state.succeeded ?? false, state.failed ?? false],
  )
}

async function currentUserId(db: Db): Promise<string> {
  const result = await db.query<{ uid: string | null }>('SELECT auth.uid() AS uid')
  const uid = result.rows[0]?.uid
  if (!uid) throw new Error('no authenticated user in session')
  return uid
}
