import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInstrument, recordTrade } from '@/lib/ledger/instruments'
import { loadHoldings } from '@/lib/read/holdings'
import type { Db } from '@/lib/db/client'
import { createTestDb, seedAccounts, USER_A, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db

beforeEach(async () => {
  testDb = await createTestDb()
  await seedAccounts(testDb, USER_A)
  db = await testDb.asDb(USER_A)

  await db.query(
    `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
     VALUES ($1, 'USD', 'HKD', '2026-08-17', 7.8, 'manual')`,
    [USER_A],
  )
})

afterEach(async () => {
  await testDb.close()
})

async function insertAccount(name: string, currency: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own)
     VALUES ($1, $2, 'brokerage', $3, false, true) RETURNING id`,
    [USER_A, name, currency],
  )
  return result.rows[0]!.id
}

describe('loadHoldings', () => {
  it('keeps the same instrument in two different accounts as two separate rows', async () => {
    const zaId = await insertAccount('ZA Invest', 'USD')
    const moxId = await insertAccount('Mox Invest', 'USD')
    const { id: instrumentId } = await createInstrument(db, {
      symbol: 'AAPL',
      kind: 'stock',
      currency: 'USD',
    })

    await recordTrade(db, {
      instrumentId,
      accountId: zaId,
      side: 'buy',
      quantity: '2',
      amount: '300.00',
      description: 'AAPL via ZA',
    })
    await recordTrade(db, {
      instrumentId,
      accountId: moxId,
      side: 'buy',
      quantity: '3',
      amount: '450.00',
      description: 'AAPL via Mox',
    })

    const holdings = await loadHoldings(db, new Date('2026-08-17T00:00:00Z'))
    expect(holdings).toHaveLength(2)

    const za = holdings.find((h) => h.accountId === zaId)
    const mox = holdings.find((h) => h.accountId === moxId)

    // This is the "AAPL 2 shares in ZA Bank" shape — same symbol, distinct
    // rows, each carrying its own account name and its own cost basis.
    expect(za).toMatchObject({ symbol: 'AAPL', accountName: 'ZA Invest', quantity: '2.0000000000' })
    expect(mox).toMatchObject({ symbol: 'AAPL', accountName: 'Mox Invest', quantity: '3.0000000000' })
  })

  it('drops a position out once its account fully sells, in that account only', async () => {
    const zaId = await insertAccount('ZA Invest', 'USD')
    const moxId = await insertAccount('Mox Invest', 'USD')
    const { id: instrumentId } = await createInstrument(db, {
      symbol: 'AAPL',
      kind: 'stock',
      currency: 'USD',
    })

    await recordTrade(db, {
      instrumentId,
      accountId: zaId,
      side: 'buy',
      quantity: '2',
      amount: '300.00',
      description: '',
    })
    await recordTrade(db, {
      instrumentId,
      accountId: zaId,
      side: 'sell',
      quantity: '2',
      amount: '320.00',
      description: '',
    })
    await recordTrade(db, {
      instrumentId,
      accountId: moxId,
      side: 'buy',
      quantity: '1',
      amount: '150.00',
      description: '',
    })

    const holdings = await loadHoldings(db, new Date('2026-08-17T00:00:00Z'))
    expect(holdings).toHaveLength(1)
    expect(holdings[0]).toMatchObject({ accountId: moxId, accountName: 'Mox Invest' })
  })
})
