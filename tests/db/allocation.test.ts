import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordSimpleTransaction } from '@/lib/ledger/record'
import type { Db } from '@/lib/db/client'
import { createTestDb, seedAccounts, USER_A, type SeededAccounts, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db
let accounts: SeededAccounts

beforeEach(async () => {
  testDb = await createTestDb()
  accounts = await seedAccounts(testDb, USER_A)
  db = await testDb.asDb(USER_A)
})

afterEach(async () => {
  await testDb.close()
})

async function suggestionsFor(transactionId: string) {
  const result = await db.query<{
    inflow_hkd_minor: string | number
    suggested_hkd_minor: string | number
    state: string
  }>(
    `SELECT inflow_hkd_minor, suggested_hkd_minor, state::text AS state
       FROM allocation_suggestions WHERE trigger_transaction_id = $1`,
    [transactionId],
  )
  // PGlite returns bigint columns as `number`, postgres.js as `string` — the
  // same discrepancy `lib/read/accounts.ts`'s `toBigInt()` already guards.
  return result.rows.map((row) => ({
    inflow_hkd_minor: String(row.inflow_hkd_minor),
    suggested_hkd_minor: String(row.suggested_hkd_minor),
    state: row.state,
  }))
}

describe('allocation suggestion trigger — PLAN §8, wired in recordSimpleTransaction', () => {
  it('fires on an external inflow at or above the 2,000 HKD default threshold', async () => {
    // 5,000.00 HKD income @ default 30%
    const result = await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '5000',
      direction: 'income',
      description: 'Salary',
    })

    const suggestions = await suggestionsFor(result.transactionId)
    expect(suggestions).toEqual([
      { inflow_hkd_minor: '500000', suggested_hkd_minor: '150000', state: 'pending' },
    ])
  })

  it('does not fire below the threshold', async () => {
    const result = await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '1999.99',
      direction: 'income',
      description: 'Refund',
    })
    expect(await suggestionsFor(result.transactionId)).toEqual([])
  })

  it('never fires on a spend, regardless of amount', async () => {
    const result = await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '50000',
      direction: 'spend',
      description: 'Rent',
    })
    expect(await suggestionsFor(result.transactionId)).toEqual([])
  })

  it('fires at most once per transaction — the UNIQUE constraint, not application logic', async () => {
    const result = await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '5000',
      direction: 'income',
      description: 'Salary',
    })

    // Simulates a second evaluation of the same already-fired transaction —
    // the idempotency guarantee PLAN §8 requires is structural (the UNIQUE
    // constraint + ON CONFLICT DO NOTHING), not a check this test could fool
    // by calling recordSimpleTransaction twice (that would just mint a second,
    // distinct transactionId).
    await db.query(
      `INSERT INTO allocation_suggestions
         (user_id, trigger_transaction_id, inflow_hkd_minor, suggested_hkd_minor, rule_version, state)
       VALUES ($1, $2, $3, $4, '1', 'pending')
       ON CONFLICT (trigger_transaction_id) DO NOTHING`,
      [USER_A, result.transactionId, '999999', '999999'],
    )

    const suggestions = await suggestionsFor(result.transactionId)
    expect(suggestions).toHaveLength(1)
    // The conflicting second insert's bogus amount never landed.
    expect(suggestions[0]!.suggested_hkd_minor).toBe('150000')
  })

  it('two separate qualifying inflows each get their own suggestion', async () => {
    const first = await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '5000',
      direction: 'income',
      description: 'Salary',
    })
    const second = await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '3000',
      direction: 'income',
      description: 'Bonus',
    })

    expect(await suggestionsFor(first.transactionId)).toHaveLength(1)
    expect(await suggestionsFor(second.transactionId)).toHaveLength(1)

    const total = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM allocation_suggestions`,
    )
    expect(total.rows[0]!.n).toBe(2)
  })
})
