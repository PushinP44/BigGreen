import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordSimpleTransaction } from '@/lib/ledger/record'
import { listAccountBalances, liquidTotalHkdMinor } from '@/lib/read/accounts'
import type { Db } from '@/lib/db/client'
import { createTestDb, seedAccounts, USER_A, type SeededAccounts, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db
let accounts: SeededAccounts
let thbAccountId: string

beforeEach(async () => {
  testDb = await createTestDb()
  accounts = await seedAccounts(testDb, USER_A)
  db = await testDb.asDb(USER_A)

  const thb = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own)
     VALUES ($1, 'Thai Baht', 'cash', 'THB', true, true) RETURNING id`,
    [USER_A],
  )
  thbAccountId = thb.rows[0]!.id

  await db.query(
    `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
     VALUES ($1, 'THB', 'HKD', '2026-08-11', 0.22415, 'manual')`,
    [USER_A],
  )
})

afterEach(async () => {
  await testDb.close()
})

async function balanceOf(accountId: string): Promise<bigint> {
  const all = await listAccountBalances(db)
  const account = all.find((a) => a.id === accountId)
  if (!account) throw new Error('account not found')
  return account.balanceMinor
}

describe('recordSimpleTransaction', () => {
  /**
   * The regression test for the bug the deferred trigger caught during P0: each
   * `query()` autocommits, so writing a transaction's entries one statement at
   * a time fired the zero-sum trigger on the very first entry. Everything below
   * would fail without the explicit BEGIN/COMMIT in `recordSimpleTransaction`.
   */
  it('writes header and entries in one database transaction', async () => {
    const result = await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '123.45',
      direction: 'spend',
      description: 'Lunch',
    })

    expect(result.transactionId).toBeTypeOf('string')
    expect(result.residualMinor).toBe(0n)

    const entries = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM entries WHERE transaction_id = $1',
      [result.transactionId],
    )
    expect(entries.rows[0]!.n).toBe(2)
  })

  it('moves money out of the account and into expenses on a spend', async () => {
    await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '123.45',
      direction: 'spend',
      description: 'Lunch',
    })

    expect(await balanceOf(accounts.bank)).toBe(-12345n)
    expect(await balanceOf(accounts.expense)).toBe(12345n)
  })

  it('moves money the other way on income', async () => {
    await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '5000',
      direction: 'income',
      description: 'Salary',
    })

    expect(await balanceOf(accounts.bank)).toBe(500000n)
    expect(await balanceOf(accounts.income)).toBe(-500000n)
  })

  it('leaves the ledger summing to zero across every entry', async () => {
    await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '10',
      direction: 'spend',
      description: 'a',
    })
    await recordSimpleTransaction(db, {
      accountId: thbAccountId,
      amount: '1000.50',
      direction: 'spend',
      description: 'b',
    })

    const total = await db.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount_hkd_minor), 0)::text AS total FROM entries',
    )
    expect(BigInt(total.rows[0]!.total)).toBe(0n)
  })

  describe('multi-currency', () => {
    it('freezes the rate and records the HKD equivalent', async () => {
      // 1000.50 THB @ 0.22415 = 224.26... → 22426 HKD minor units
      await recordSimpleTransaction(db, {
        accountId: thbAccountId,
        amount: '1000.50',
        direction: 'spend',
        description: 'Bangkok dinner',
      })

      const rows = await db.query<{
        amount_minor: string
        amount_hkd_minor: string
        fx_rate_to_hkd: string
        currency: string
      }>(
        `SELECT amount_minor, amount_hkd_minor, fx_rate_to_hkd, currency
           FROM entries WHERE account_id = $1`,
        [thbAccountId],
      )

      const entry = rows.rows[0]!
      expect(entry.currency.trim()).toBe('THB')
      expect(BigInt(entry.amount_minor)).toBe(-100050n)
      expect(BigInt(entry.amount_hkd_minor)).toBe(-22426n)
      // Frozen at event time, never recomputed (PLAN D2).
      expect(Number(entry.fx_rate_to_hkd)).toBeCloseTo(0.22415, 8)
    })

    it('counts a foreign balance toward liquid at its frozen rate', async () => {
      await recordSimpleTransaction(db, {
        accountId: thbAccountId,
        amount: '1000.50',
        direction: 'income',
        description: 'refund',
      })

      const all = await listAccountBalances(db)
      expect(liquidTotalHkdMinor(all)).toBe(22426n)
    })

    it('never sums raw minor units across currencies', async () => {
      // The bug this pins: Expenses is an HKD account that receives entries in
      // every currency. Summing `amount_minor` blind made a 1,000.50 THB spend
      // render as "HK$1,000.50" — a number that is not money in any currency.
      await recordSimpleTransaction(db, {
        accountId: thbAccountId,
        amount: '1000.50',
        direction: 'spend',
        description: 'Bangkok dinner',
      })
      await recordSimpleTransaction(db, {
        accountId: accounts.bank,
        amount: '50',
        direction: 'spend',
        description: 'MTR',
      })

      const all = await listAccountBalances(db)
      const expenses = all.find((a) => a.id === accounts.expense)!

      // Native balance counts only the genuinely-HKD entry...
      expect(expenses.balanceMinor).toBe(5000n)
      // ...while the HKD total counts both, at each entry's frozen rate.
      expect(expenses.balanceHkdMinor).toBe(5000n + 22426n)
      // ...and the account is flagged as holding foreign entries, so callers
      // know the native figure is partial.
      expect(expenses.foreignEntryCount).toBe(1)
    })

    it('refuses a currency with no rate rather than guessing one', async () => {
      const usd = await db.query<{ id: string }>(
        `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own)
         VALUES ($1, 'HSBC USD', 'bank', 'USD', true, true) RETURNING id`,
        [USER_A],
      )

      await expect(
        recordSimpleTransaction(db, {
          accountId: usd.rows[0]!.id,
          amount: '100',
          direction: 'spend',
          description: 'x',
        }),
      ).rejects.toThrow(/no USD\/HKD rate available/)
    })
  })

  describe('input validation', () => {
    it('rejects a zero or negative amount', async () => {
      for (const amount of ['0', '-5']) {
        await expect(
          recordSimpleTransaction(db, {
            accountId: accounts.bank,
            amount,
            direction: 'spend',
            description: '',
          }),
        ).rejects.toThrow(/greater than zero/)
      }
    })

    it('rejects more precision than the currency has', async () => {
      await expect(
        recordSimpleTransaction(db, {
          accountId: accounts.bank,
          amount: '1.234',
          direction: 'spend',
          description: '',
        }),
      ).rejects.toThrow(/decimal places/)
    })

    it('rejects an unknown account', async () => {
      await expect(
        recordSimpleTransaction(db, {
          accountId: '99999999-9999-4999-8999-999999999999',
          amount: '1',
          direction: 'spend',
          description: '',
        }),
      ).rejects.toThrow(/account not found/)
    })

    it('leaves nothing behind when a write fails', async () => {
      // A rolled-back attempt must not leave an orphan transaction header —
      // which is exactly what the pre-fix autocommit behaviour did.
      await expect(
        recordSimpleTransaction(db, {
          accountId: accounts.bank,
          amount: 'not a number',
          direction: 'spend',
          description: '',
        }),
      ).rejects.toThrow()

      const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM transactions')
      expect(count.rows[0]!.n).toBe(0)
    })
  })
})
