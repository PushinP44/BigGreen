import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchQuote, syncPrices, FinnhubError, PRICES_SOURCE_KEY } from '@/lib/fx/finnhub'
import type { Db } from '@/lib/db/client'
import { createTestDb, USER_A, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db
const now = new Date('2026-08-14T04:00:00Z') // 12:00 HKT

beforeEach(async () => {
  testDb = await createTestDb()
  db = await testDb.asDb(USER_A)
  process.env.FINANCE_API_KEY = 'test-key'
})

afterEach(async () => {
  delete process.env.FINANCE_API_KEY
  await testDb.close()
})

/** Stands in for Finnhub's /quote endpoint. */
function stubFetch(quotes: Record<string, { c: number; pc: number } | 'error'>) {
  return async (url: string): Promise<Response> => {
    const symbol = new URL(url).searchParams.get('symbol') ?? ''
    const quote = quotes[symbol]

    if (quote === undefined) return Response.json({ c: 0, pc: 0 }) // unrecognised symbol
    if (quote === 'error') return new Response('nope', { status: 500 })
    return Response.json(quote)
  }
}

async function addInstrument(symbol: string, currency = 'HKD'): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO instruments (user_id, symbol, kind, currency) VALUES ($1, $2, 'stock', $3) RETURNING id`,
    [USER_A, symbol, currency],
  )
  return result.rows[0]!.id
}

async function storedPrice(instrumentId: string): Promise<{ closeMinor: string; source: string } | undefined> {
  const result = await db.query<{ close_minor: string | number; source: string }>(
    `SELECT close_minor, source FROM prices WHERE instrument_id = $1 ORDER BY as_of DESC LIMIT 1`,
    [instrumentId],
  )
  const row = result.rows[0]
  // PGlite returns bigint columns as `number`, postgres.js as `string` — the
  // same discrepancy `lib/read/accounts.ts`'s `toBigInt()` already guards.
  return row ? { closeMinor: String(row.close_minor), source: row.source } : undefined
}

describe('fetchQuote', () => {
  it('converts a price to minor units for the currency', async () => {
    const quote = await fetchQuote('AAPL', 'USD', 'key', stubFetch({ AAPL: { c: 150.5, pc: 148 } }))
    expect(quote).toEqual({ symbol: 'AAPL', priceMinor: 15050n })
  })

  it('treats an all-zero response as an unrecognised symbol, not a real price', async () => {
    await expect(
      fetchQuote('NOTREAL', 'USD', 'key', stubFetch({})),
    ).rejects.toThrow(/does not recognise/)
  })

  it('throws on a non-200 rather than writing nothing silently', async () => {
    await expect(
      fetchQuote('AAPL', 'USD', 'key', stubFetch({ AAPL: 'error' })),
    ).rejects.toThrow(FinnhubError)
  })
})

describe('syncPrices', () => {
  it('writes a price for every instrument it can quote', async () => {
    const aapl = await addInstrument('AAPL', 'USD')
    const result = await syncPrices(db, now, stubFetch({ AAPL: { c: 150.5, pc: 148 } }))

    expect(result.written).toBe(1)
    expect(result.failed).toEqual([])
    expect(await storedPrice(aapl)).toEqual({ closeMinor: '15050', source: 'finnhub' })
  })

  it('is idempotent — re-running at an unchanged price writes nothing new', async () => {
    await addInstrument('AAPL', 'USD')
    const fetcher = stubFetch({ AAPL: { c: 150.5, pc: 148 } })
    await syncPrices(db, now, fetcher)
    const second = await syncPrices(db, now, fetcher)

    expect(second.written).toBe(0)
    expect(second.unchanged).toBe(1)
  })

  it('never overwrites a manually-entered price for the same day', async () => {
    const aapl = await addInstrument('AAPL', 'USD')
    await db.query(
      `INSERT INTO prices (user_id, instrument_id, as_of, close_minor, currency, source)
       VALUES ($1, $2, $3, $4, 'USD', 'manual')`,
      [USER_A, aapl, '2026-08-14', '99999'],
    )

    await syncPrices(db, now, stubFetch({ AAPL: { c: 150.5, pc: 148 } }))
    expect(await storedPrice(aapl)).toEqual({ closeMinor: '99999', source: 'manual' })
  })

  it('does not let one bad symbol block the rest of the batch', async () => {
    const aapl = await addInstrument('AAPL', 'USD')
    const ghost = await addInstrument('GHOST', 'USD')

    const result = await syncPrices(db, now, stubFetch({ AAPL: { c: 150.5, pc: 148 } }))

    expect(result.written).toBe(1)
    expect(result.failed).toEqual([{ symbol: 'GHOST', reason: expect.stringContaining('does not recognise') }])
    expect(await storedPrice(aapl)).toEqual({ closeMinor: '15050', source: 'finnhub' })
    expect(await storedPrice(ghost)).toBeUndefined()
  })

  it('records a heartbeat so a dead feed is visible', async () => {
    await addInstrument('AAPL', 'USD')
    await syncPrices(db, now, stubFetch({ AAPL: { c: 150.5, pc: 148 } }))

    const beat = await db.query<{ last_success_at: string | null; consecutive_failures: number }>(
      `SELECT last_success_at, consecutive_failures FROM ingest_sources WHERE source_key = $1`,
      [PRICES_SOURCE_KEY],
    )
    expect(beat.rows[0]?.last_success_at).not.toBeNull()
    expect(beat.rows[0]?.consecutive_failures).toBe(0)
  })

  it('counts a heartbeat failure only when every symbol fails, not just one', async () => {
    await addInstrument('AAPL', 'USD')
    await addInstrument('GHOST', 'USD')

    // Both fail: AAPL errors, GHOST is unrecognised.
    await syncPrices(db, now, stubFetch({ AAPL: 'error' }))

    const beat = await db.query<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM ingest_sources WHERE source_key = $1`,
      [PRICES_SOURCE_KEY],
    )
    expect(beat.rows[0]?.consecutive_failures).toBe(1)
  })

  it('throws immediately when the API key is not configured', async () => {
    delete process.env.FINANCE_API_KEY
    await addInstrument('AAPL', 'USD')
    await expect(syncPrices(db, now, stubFetch({}))).rejects.toThrow(/FINANCE_API_KEY/)
  })
})
