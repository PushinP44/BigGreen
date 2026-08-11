import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordTransfer } from '@/lib/ledger/record'
import { listAccountBalances } from '@/lib/read/accounts'
import type { Db } from '@/lib/db/client'
import { createTestDb, seedAccounts, USER_A, type SeededAccounts, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db
let accounts: SeededAccounts
let brokerId: string
let usdId: string
let fxGainLossId: string

beforeEach(async () => {
  testDb = await createTestDb()
  accounts = await seedAccounts(testDb, USER_A)
  db = await testDb.asDb(USER_A)

  const insert = async (name: string, kind: string, currency: string, systemRole?: string) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, system_role)
       VALUES ($1, $2, $3::account_kind, $4, $5, $6, $7) RETURNING id`,
      [USER_A, name, kind, currency, kind !== 'expense', kind !== 'expense', systemRole ?? null],
    )
    return r.rows[0]!.id
  }

  brokerId = await insert('Broker', 'brokerage', 'HKD')
  usdId = await insert('HSBC USD', 'bank', 'USD')
  fxGainLossId = await insert('FX Gain/Loss', 'expense', 'HKD', 'fx_gain_loss')

  await db.query(
    `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
     VALUES ($1, 'USD', 'HKD', '2026-08-11', 7.8321, 'manual')`,
    [USER_A],
  )
})

afterEach(async () => {
  await testDb.close()
})

async function balanceOf(accountId: string): Promise<bigint> {
  const all = await listAccountBalances(db)
  return all.find((a) => a.id === accountId)!.balanceMinor
}

describe('same-currency transfer', () => {
  it('moves money without creating income or spending', async () => {
    await recordTransfer(db, {
      fromAccountId: accounts.bank,
      toAccountId: brokerId,
      amount: '5000',
      description: 'To broker',
    })

    expect(await balanceOf(accounts.bank)).toBe(-500000n)
    expect(await balanceOf(brokerId)).toBe(500000n)
    // Neither outside-world account is touched — that is what stops the
    // allocation rule firing a false "invest 30%" notice (PLAN §8).
    expect(await balanceOf(accounts.income)).toBe(0n)
    expect(await balanceOf(accounts.expense)).toBe(0n)
  })

  it('books no FX residual', async () => {
    const result = await recordTransfer(db, {
      fromAccountId: accounts.bank,
      toAccountId: brokerId,
      amount: '5000',
      description: 'To broker',
    })
    expect(result.residualMinor).toBe(0n)
  })
})

describe('cross-currency transfer', () => {
  it('requires the amount that actually arrived', async () => {
    // The reference rate is not the rate the bank gave you, and guessing would
    // silently invent money.
    await expect(
      recordTransfer(db, {
        fromAccountId: usdId,
        toAccountId: accounts.bank,
        amount: '100',
        description: 'USD to HKD',
      }),
    ).rejects.toThrow(/needs the amount that actually arrived/)
  })

  it("books the bank's spread to FX Gain/Loss, not FX Rounding", async () => {
    // 100.00 USD leaves (783.21 HKD at reference), 780.00 HKD arrives.
    // The 3.21 HKD gap is the spread — real money, and it must be visible.
    const result = await recordTransfer(db, {
      fromAccountId: usdId,
      toAccountId: accounts.bank,
      amount: '100',
      toAmount: '780',
      description: 'USD to HKD',
    })

    expect(await balanceOf(usdId)).toBe(-10000n)
    expect(await balanceOf(accounts.bank)).toBe(78000n)
    expect(await balanceOf(fxGainLossId)).toBe(321n)

    expect(result.residualMinor).toBe(-321n)
    expect(await balanceOf(accounts.fxRounding)).toBe(0n)
  })

  it('still balances to zero across every entry', async () => {
    await recordTransfer(db, {
      fromAccountId: usdId,
      toAccountId: accounts.bank,
      amount: '100',
      toAmount: '780',
      description: 'USD to HKD',
    })

    const total = await db.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount_hkd_minor), 0)::text AS total FROM entries',
    )
    expect(BigInt(total.rows[0]!.total)).toBe(0n)
  })

  it('rejects a gap too large to be a spread', async () => {
    await expect(
      recordTransfer(db, {
        fromAccountId: usdId,
        toAccountId: accounts.bank,
        amount: '100',
        toAmount: '78', // a decimal-point slip, not a bank fee
        description: 'oops',
      }),
    ).rejects.toThrow(/typo, not a spread/)
  })
})

describe('guards', () => {
  it('refuses to transfer an account to itself', async () => {
    await expect(
      recordTransfer(db, {
        fromAccountId: accounts.bank,
        toAccountId: accounts.bank,
        amount: '100',
        description: '',
      }),
    ).rejects.toThrow(/itself/)
  })

  it('refuses to transfer to an outside-world account', async () => {
    // Sending money to "Expenses" via the transfer flow would hide real
    // spending from every read model.
    await expect(
      recordTransfer(db, {
        fromAccountId: accounts.bank,
        toAccountId: accounts.expense,
        amount: '100',
        description: '',
      }),
    ).rejects.toThrow(/accounts you own/)
  })

  it('refuses a zero or negative amount', async () => {
    await expect(
      recordTransfer(db, {
        fromAccountId: accounts.bank,
        toAccountId: brokerId,
        amount: '0',
        description: '',
      }),
    ).rejects.toThrow(/greater than zero/)
  })
})
