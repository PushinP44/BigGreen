import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDb,
  insertBalancedTransaction,
  seedAccounts,
  USER_A,
  type TestDb,
} from '../support/db'

let db: TestDb

beforeEach(async () => {
  db = await createTestDb()
})

afterEach(async () => {
  await db.close()
})

describe('migrations', () => {
  it('applies cleanly to an empty database', async () => {
    const result = await db.pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    )
    const tables = result.rows.map((r) => r.table_name)

    expect(tables).toEqual([
      'accounts',
      'allocation_suggestions',
      'categories',
      'entries',
      'fx_rates',
      'ingest_sources',
      'instruments',
      'prices',
      'recurrences',
      'rule_settings',
      'transactions',
    ])
  })

  it('enables row-level security on every table without exception', async () => {
    // The failure mode this catches is a table added later without a policy —
    // which looks fine in every test that does not check for it.
    const result = await db.pg.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'`,
    )
    const unprotected = result.rows.filter((r) => !r.rowsecurity).map((r) => r.tablename)
    expect(unprotected).toEqual([])
  })

  it('gives every table exactly one owner policy', async () => {
    const result = await db.pg.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`,
    )
    expect(result.rows).toHaveLength(11)
    for (const row of result.rows) {
      expect(row.policyname).toBe(`${row.tablename}_owner`)
    }
  })
})

describe('double-entry zero-sum trigger', () => {
  it('accepts a balanced transaction', async () => {
    const accounts = await seedAccounts(db, USER_A)
    await expect(
      insertBalancedTransaction(db, USER_A, {
        debitAccountId: accounts.expense,
        creditAccountId: accounts.bank,
        amountHkdMinor: 12345n,
      }),
    ).resolves.toBeTypeOf('string')
  })

  it('rejects entries that do not sum to zero', async () => {
    const accounts = await seedAccounts(db, USER_A)

    await expect(
      db.asUser(USER_A, async () => {
        const txn = await db.pg.query<{ id: string }>(
          `INSERT INTO transactions (user_id, occurred_at) VALUES ($1, now()) RETURNING id`,
          [USER_A],
        )
        const id = txn.rows[0]!.id
        await db.pg.query(
          `INSERT INTO entries
             (user_id, transaction_id, account_id, amount_minor, currency, fx_rate_to_hkd, amount_hkd_minor)
           VALUES
             ($1, $2, $3, 10000, 'HKD', 1, 10000),
             ($1, $2, $4, -9999, 'HKD', 1, -9999)`,
          [USER_A, id, accounts.expense, accounts.bank],
        )
      }),
    ).rejects.toThrow(/sum to 1 HKD minor units/)
  })

  it('rejects a single-entry transaction', async () => {
    const accounts = await seedAccounts(db, USER_A)

    await expect(
      db.asUser(USER_A, async () => {
        const txn = await db.pg.query<{ id: string }>(
          `INSERT INTO transactions (user_id, occurred_at) VALUES ($1, now()) RETURNING id`,
          [USER_A],
        )
        await db.pg.query(
          `INSERT INTO entries
             (user_id, transaction_id, account_id, amount_minor, currency, fx_rate_to_hkd, amount_hkd_minor)
           VALUES ($1, $2, $3, 0, 'HKD', 1, 0)`,
          [USER_A, txn.rows[0]!.id, accounts.bank],
        )
      }),
    ).rejects.toThrow(/requires at least 2/)
  })

  it('allows a transaction to be deleted with its entries', async () => {
    // The trigger fires per cascaded row; zero remaining entries must not read
    // as an imbalance.
    const accounts = await seedAccounts(db, USER_A)
    const id = await insertBalancedTransaction(db, USER_A, {
      debitAccountId: accounts.expense,
      creditAccountId: accounts.bank,
      amountHkdMinor: 500n,
    })

    await db.asUser(USER_A, async () => {
      await db.pg.query('DELETE FROM transactions WHERE id = $1', [id])
    })

    const remaining = await db.asUser(USER_A, () =>
      db.pg.query('SELECT count(*)::int AS n FROM entries'),
    )
    expect((remaining.rows[0] as { n: number }).n).toBe(0)
  })
})

describe('schema invariants', () => {
  it('refuses an account that is liquid but not owned', async () => {
    await expect(
      db.asUser(USER_A, () =>
        db.pg.query(
          `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own)
           VALUES ($1, 'Someone else money', 'bank', 'HKD', true, false)`,
          [USER_A],
        ),
      ),
    ).rejects.toThrow(/accounts_liquid_implies_own/)
  })

  it('refuses an unsupported currency', async () => {
    await expect(
      db.asUser(USER_A, () =>
        db.pg.query(
          `INSERT INTO accounts (user_id, name, kind, currency) VALUES ($1, 'Euro', 'bank', 'EUR')`,
          [USER_A],
        ),
      ),
    ).rejects.toThrow(/accounts_currency_check/)
  })

  it('refuses an investment leg with an instrument but no quantity', async () => {
    const accounts = await seedAccounts(db, USER_A)
    await expect(
      db.asUser(USER_A, async () => {
        const txn = await db.pg.query<{ id: string }>(
          `INSERT INTO transactions (user_id, occurred_at) VALUES ($1, now()) RETURNING id`,
          [USER_A],
        )
        const inst = await db.pg.query<{ id: string }>(
          `INSERT INTO instruments (user_id, symbol, kind, currency)
           VALUES ($1, '0700.HK', 'stock', 'HKD') RETURNING id`,
          [USER_A],
        )
        await db.pg.query(
          `INSERT INTO entries
             (user_id, transaction_id, account_id, amount_minor, currency,
              fx_rate_to_hkd, amount_hkd_minor, instrument_id)
           VALUES ($1, $2, $3, 0, 'HKD', 1, 0, $4)`,
          [USER_A, txn.rows[0]!.id, accounts.bank, inst.rows[0]!.id],
        )
      }),
    ).rejects.toThrow(/entries_instrument_quantity_together/)
  })

  it('refuses a non-positive FX rate', async () => {
    const accounts = await seedAccounts(db, USER_A)
    await expect(
      db.asUser(USER_A, async () => {
        const txn = await db.pg.query<{ id: string }>(
          `INSERT INTO transactions (user_id, occurred_at) VALUES ($1, now()) RETURNING id`,
          [USER_A],
        )
        await db.pg.query(
          `INSERT INTO entries
             (user_id, transaction_id, account_id, amount_minor, currency, fx_rate_to_hkd, amount_hkd_minor)
           VALUES ($1, $2, $3, 100, 'USD', 0, 0)`,
          [USER_A, txn.rows[0]!.id, accounts.bank],
        )
      }),
    ).rejects.toThrow(/entries_fx_rate_positive/)
  })

  it('refuses an allocation suggestion larger than its inflow', async () => {
    const accounts = await seedAccounts(db, USER_A)
    const id = await insertBalancedTransaction(db, USER_A, {
      debitAccountId: accounts.bank,
      creditAccountId: accounts.income,
      amountHkdMinor: 200000n,
    })

    await expect(
      db.asUser(USER_A, () =>
        db.pg.query(
          `INSERT INTO allocation_suggestions
             (user_id, trigger_transaction_id, inflow_hkd_minor, suggested_hkd_minor, rule_version)
           VALUES ($1, $2, 200000, 300000, 'v1')`,
          [USER_A, id],
        ),
      ),
    ).rejects.toThrow(/allocation_within_inflow/)
  })

  it('fires an allocation suggestion at most once per transaction', async () => {
    const accounts = await seedAccounts(db, USER_A)
    const id = await insertBalancedTransaction(db, USER_A, {
      debitAccountId: accounts.bank,
      creditAccountId: accounts.income,
      amountHkdMinor: 200000n,
    })

    await db.asUser(USER_A, () =>
      db.pg.query(
        `INSERT INTO allocation_suggestions
           (user_id, trigger_transaction_id, inflow_hkd_minor, suggested_hkd_minor, rule_version)
         VALUES ($1, $2, 200000, 60000, 'v1')`,
        [USER_A, id],
      ),
    )

    await expect(
      db.asUser(USER_A, () =>
        db.pg.query(
          `INSERT INTO allocation_suggestions
             (user_id, trigger_transaction_id, inflow_hkd_minor, suggested_hkd_minor, rule_version)
           VALUES ($1, $2, 200000, 60000, 'v1')`,
          [USER_A, id],
        ),
      ),
    ).rejects.toThrow(/trigger_transaction_id/)
  })
})
