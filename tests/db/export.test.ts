import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordSimpleTransaction } from '@/lib/ledger/record'
import { buildExportRows, toCsv } from '@/lib/read/export'
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

describe('export', () => {
  it('writes both legs of every transaction', async () => {
    await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '248.50',
      direction: 'spend',
      description: 'Dim sum',
    })

    const rows = await buildExportRows(db)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.account).sort()).toEqual(['Expenses', 'HSBC HKD'])
  })

  it('serialises amounts as strings, not JSON numbers', async () => {
    // The export is the hedge against this project stalling (PLAN §14), so it
    // has to be lossless. int8 arriving as a `number` is precision loss waiting
    // to happen and disagrees with the CSV.
    await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '248.50',
      direction: 'spend',
      description: 'Dim sum',
    })

    const rows = await buildExportRows(db)
    for (const row of rows) {
      expect(typeof row.amount_minor).toBe('string')
      expect(typeof row.amount_hkd_minor).toBe('string')
      expect(typeof row.fx_rate_to_hkd).toBe('string')
    }
    expect(rows.map((r) => r.amount_minor).sort()).toEqual(['-24850', '24850'])
  })

  it('serialises timestamps as ISO 8601', async () => {
    // Not "Wed Aug 12 2026 00:04:04 GMT+0800 (Hong Kong Standard Time)", which
    // is what a raw Date stringifies to and which nothing can parse back.
    await recordSimpleTransaction(db, {
      accountId: accounts.bank,
      amount: '10',
      direction: 'spend',
      description: 'x',
      occurredAt: new Date('2026-08-11T16:04:04.128Z'),
    })

    const rows = await buildExportRows(db)
    expect(rows[0]?.occurred_at).toBe('2026-08-11T16:04:04.128Z')
    expect(Number.isNaN(Date.parse(rows[0]!.occurred_at))).toBe(false)
  })

  it('preserves the frozen FX rate, without which HKD cannot be rebuilt', async () => {
    await db.query(
      `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own)
       VALUES ($1, 'Thai Baht', 'cash', 'THB', true, true)`,
      [USER_A],
    )
    await db.query(
      `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
       VALUES ($1, 'THB', 'HKD', '2026-08-11', 0.22415, 'manual')`,
      [USER_A],
    )
    const thb = await db.query<{ id: string }>(
      `SELECT id FROM accounts WHERE currency = 'THB' LIMIT 1`,
    )

    await recordSimpleTransaction(db, {
      accountId: thb.rows[0]!.id,
      amount: '1000.50',
      direction: 'spend',
      description: 'Bangkok',
    })

    const rows = await buildExportRows(db)
    // Both legs are THB — the account and the counterparty. Pick the account
    // leg, which is the one carrying the outflow.
    const accountLeg = rows.find((r) => r.account === 'Thai Baht')
    const counterpartyLeg = rows.find((r) => r.account === 'Expenses')

    expect(Number(accountLeg?.fx_rate_to_hkd)).toBeCloseTo(0.22415, 8)
    expect(accountLeg?.amount_minor).toBe('-100050')
    expect(accountLeg?.amount_hkd_minor).toBe('-22426')

    // And the pair still balances in the export, so the file reconstructs the
    // ledger rather than half of it.
    expect(BigInt(accountLeg!.amount_hkd_minor) + BigInt(counterpartyLeg!.amount_hkd_minor)).toBe(0n)
  })
})

describe('CSV encoding', () => {
  it('quotes cells containing commas, quotes and newlines', () => {
    // "Lunch, 2 people" would otherwise shift every later column in that row.
    const csv = toCsv([
      {
        transaction_id: 'a',
        occurred_at: '2026-08-11T00:00:00.000Z',
        status: 'posted',
        source: 'manual',
        description: 'Lunch, 2 people',
        merchant: 'He said "hi"',
        category: null,
        notes: 'line one\nline two',
        account: 'HSBC HKD',
        account_kind: 'bank',
        amount_minor: '-100',
        currency: 'HKD',
        fx_rate_to_hkd: '1.00000000',
        amount_hkd_minor: '-100',
        is_fx_residual: false,
      },
    ])

    const lines = csv.split('\r\n')
    expect(lines[0]).toContain('transaction_id,occurred_at')
    expect(lines[1]).toContain('"Lunch, 2 people"')
    expect(lines[1]).toContain('"He said ""hi"""')
    expect(csv).toContain('"line one\nline two"')
  })

  it('renders null as an empty cell rather than the text "null"', () => {
    const csv = toCsv([
      {
        transaction_id: 'a',
        occurred_at: '2026-08-11T00:00:00.000Z',
        status: 'posted',
        source: 'manual',
        description: null,
        merchant: null,
        category: null,
        notes: null,
        account: 'HSBC HKD',
        account_kind: 'bank',
        amount_minor: '-100',
        currency: 'HKD',
        fx_rate_to_hkd: '1.00000000',
        amount_hkd_minor: '-100',
        is_fx_residual: false,
      },
    ])
    expect(csv).not.toContain('null')
  })

  it('emits a header even with no rows', () => {
    expect(toCsv([]).trim()).toBe(
      'transaction_id,occurred_at,status,source,description,merchant,category,notes,' +
        'account,account_kind,amount_minor,currency,fx_rate_to_hkd,amount_hkd_minor,is_fx_residual',
    )
  })
})
