import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchRates, setManualRate, syncRates, FX_SOURCE_KEY } from '@/lib/fx/frankfurter'
import type { Db } from '@/lib/db/client'
import { createTestDb, USER_A, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db

beforeEach(async () => {
  testDb = await createTestDb()
  db = await testDb.asDb(USER_A)
})

afterEach(async () => {
  await testDb.close()
})

/** Stands in for Frankfurter. Real rates, so the assertions mean something. */
function stubFetch(
  rates: Record<string, number>,
  opts: { date?: string; status?: number; amount?: number; body?: unknown } = {},
) {
  return async (url: string): Promise<Response> => {
    const from = new URL(url).searchParams.get('from') ?? ''
    const rate = rates[from]

    if (opts.status && opts.status !== 200) {
      return new Response('nope', { status: opts.status })
    }
    if (opts.body !== undefined) {
      return Response.json(opts.body)
    }

    return Response.json({
      amount: opts.amount ?? 1,
      base: from,
      date: opts.date ?? '2026-08-11',
      rates: rate === undefined ? {} : { HKD: rate },
    })
  }
}

async function storedRate(base: string): Promise<{ rate: string; source: string } | undefined> {
  const result = await db.query<{ rate: string; source: string }>(
    `SELECT rate, source FROM fx_rates WHERE base = $1 ORDER BY as_of DESC LIMIT 1`,
    [base],
  )
  return result.rows[0]
}

describe('fetchRates', () => {
  it('reads a unit quote in the direction we store', async () => {
    const rates = await fetchRates(['USD'], stubFetch({ USD: 7.8321 }))
    expect(rates).toEqual([
      { base: 'USD', quote: 'HKD', asOf: '2026-08-11', rateText: '7.83210000' },
    ])
  })

  it('crosses the JSON-number boundary exactly once, into a fixed-scale string', async () => {
    // Nothing downstream of this function should ever see a float.
    const rates = await fetchRates(['THB'], stubFetch({ THB: 0.22415 }))
    expect(rates[0]?.rateText).toBe('0.22415000')
    expect(typeof rates[0]?.rateText).toBe('string')
  })

  it('throws on a non-200 rather than writing nothing silently', async () => {
    await expect(fetchRates(['USD'], stubFetch({}, { status: 503 }))).rejects.toThrow(/503/)
  })

  it('throws on an unexpected response shape', async () => {
    await expect(
      fetchRates(['USD'], stubFetch({}, { body: { unexpected: true } })),
    ).rejects.toThrow(/unexpected shape/)
  })

  it('throws when the quote is missing', async () => {
    await expect(fetchRates(['USD'], stubFetch({}))).rejects.toThrow(/no HKD rate/)
  })

  it('throws when the quote is not per unit', async () => {
    // amount != 1 would make every stored rate wrong by that factor.
    await expect(
      fetchRates(['USD'], stubFetch({ USD: 78.321 }, { amount: 10 })),
    ).rejects.toThrow(/unit quote/)
  })

  it('never asks for the base currency against itself', async () => {
    expect(await fetchRates(['HKD'], stubFetch({}))).toEqual([])
  })
})

describe('syncRates', () => {
  it('writes both tracked currencies', async () => {
    const result = await syncRates(db, stubFetch({ USD: 7.8321, THB: 0.22415 }))

    expect(result.written).toBe(2)
    expect(result.rejected).toEqual([])
    expect((await storedRate('USD'))?.source).toBe('frankfurter')
    expect(Number((await storedRate('THB'))?.rate)).toBeCloseTo(0.22415, 8)
  })

  it('is idempotent — re-running changes nothing', async () => {
    const fetcher = stubFetch({ USD: 7.8321, THB: 0.22415 })
    await syncRates(db, fetcher)
    const second = await syncRates(db, fetcher)

    expect(second.written).toBe(0)
    expect(second.unchanged).toBe(2)
  })

  it('rejects a rate that means the feed changed units', async () => {
    await syncRates(db, stubFetch({ USD: 7.8321, THB: 0.22415 }))

    // THB jumps 1000x — a unit change, not a market move.
    const result = await syncRates(
      db,
      stubFetch({ USD: 7.84, THB: 224.15 }, { date: '2026-08-12' }),
    )

    expect(result.rejected.map((r) => r.currency)).toEqual(['THB'])
    expect(result.written).toBe(1)

    // The bad value was never stored, so net worth is untouched.
    const thb = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fx_rates WHERE base = 'THB' AND rate > 100`,
    )
    expect(thb.rows[0]!.n).toBe(0)
  })

  it('never overwrites a manual rate', async () => {
    // You moved THB at a rate the reference does not know about. Yours wins.
    await setManualRate(db, 'THB', '2026-08-11', '0.23500000')
    await syncRates(db, stubFetch({ USD: 7.8321, THB: 0.22415 }))

    const stored = await storedRate('THB')
    expect(stored?.source).toBe('manual')
    expect(Number(stored?.rate)).toBeCloseTo(0.235, 8)
  })

  it('records a heartbeat so a dead feed is visible', async () => {
    await syncRates(db, stubFetch({ USD: 7.8321, THB: 0.22415 }))

    const beat = await db.query<{
      last_success_at: string | null
      consecutive_failures: number
    }>(`SELECT last_success_at, consecutive_failures FROM ingest_sources WHERE source_key = $1`, [
      FX_SOURCE_KEY,
    ])

    expect(beat.rows[0]?.last_success_at).not.toBeNull()
    expect(beat.rows[0]?.consecutive_failures).toBe(0)
  })

  it('counts failures on the heartbeat when the feed is down', async () => {
    // A quiet market and a dead feed look identical without this.
    await expect(syncRates(db, stubFetch({}, { status: 500 }))).rejects.toThrow()

    const beat = await db.query<{ consecutive_failures: number; last_success_at: string | null }>(
      `SELECT consecutive_failures, last_success_at FROM ingest_sources WHERE source_key = $1`,
      [FX_SOURCE_KEY],
    )
    expect(beat.rows[0]?.consecutive_failures).toBe(1)
    expect(beat.rows[0]?.last_success_at).toBeNull()
  })
})

describe('setManualRate', () => {
  it('rejects an implausible rate', async () => {
    await expect(setManualRate(db, 'USD', '2026-08-11', '0')).rejects.toThrow(/positive/)
    await expect(setManualRate(db, 'USD', '2026-08-11', '999999')).rejects.toThrow(/plausible/)
  })

  it('overwrites an earlier manual rate for the same day', async () => {
    await setManualRate(db, 'USD', '2026-08-11', '7.80000000')
    await setManualRate(db, 'USD', '2026-08-11', '7.85000000')
    expect(Number((await storedRate('USD'))?.rate)).toBeCloseTo(7.85, 8)
  })
})
