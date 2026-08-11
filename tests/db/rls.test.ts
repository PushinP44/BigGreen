import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDb,
  insertBalancedTransaction,
  seedAccounts,
  USER_A,
  USER_B,
  type SeededAccounts,
  type TestDb,
} from '../support/db'

let db: TestDb
let accountsA: SeededAccounts

beforeEach(async () => {
  db = await createTestDb()
  accountsA = await seedAccounts(db, USER_A)
  await insertBalancedTransaction(db, USER_A, {
    debitAccountId: accountsA.expense,
    creditAccountId: accountsA.bank,
    amountHkdMinor: 12345n,
  })
})

afterEach(async () => {
  await db.close()
})

async function countAs(userId: string, table: string): Promise<number> {
  const result = await db.asUser(userId, () =>
    db.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`),
  )
  return result.rows[0]?.n ?? -1
}

describe('tenant isolation', () => {
  it('lets the owner read their own rows', async () => {
    expect(await countAs(USER_A, 'accounts')).toBe(4)
    expect(await countAs(USER_A, 'transactions')).toBe(1)
    expect(await countAs(USER_A, 'entries')).toBe(2)
  })

  it("shows a second user nothing of the first user's data", async () => {
    // The single most important test in this file.
    for (const table of ['accounts', 'transactions', 'entries']) {
      expect(await countAs(USER_B, table), table).toBe(0)
    }
  })

  it('shows an anonymous caller nothing at all', async () => {
    await expect(
      db.asAnon(() => db.pg.query('SELECT count(*) FROM accounts')),
    ).rejects.toThrow(/permission denied/i)
  })

  it('covers every table, not just the ones with fixtures', async () => {
    // Guards against a table being added later with RLS enabled but a policy
    // that forgot the user_id predicate.
    const tables = [
      'accounts',
      'categories',
      'transactions',
      'entries',
      'instruments',
      'prices',
      'fx_rates',
      'recurrences',
      'allocation_suggestions',
      'ingest_sources',
      'rule_settings',
    ]

    const result = await db.pg.query<{ tablename: string; qual: string | null }>(
      `SELECT tablename, qual FROM pg_policies WHERE schemaname = 'public'`,
    )

    for (const table of tables) {
      const policy = result.rows.find((r) => r.tablename === table)
      expect(policy, `${table} has no policy`).toBeDefined()
      expect(policy?.qual, `${table} policy is not user-scoped`).toMatch(/user_id/)
    }
  })
})

describe('write protection', () => {
  it('refuses to let a user forge a row owned by someone else', async () => {
    // WITH CHECK is what stops this; USING alone would allow the insert and
    // simply hide the result.
    await expect(
      db.asUser(USER_B, () =>
        db.pg.query(
          `INSERT INTO accounts (user_id, name, kind, currency) VALUES ($1, 'forged', 'bank', 'HKD')`,
          [USER_A],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it("refuses to let a user update another user's row", async () => {
    const result = await db.asUser(USER_B, () =>
      db.pg.query(`UPDATE accounts SET name = 'hijacked'`),
    )
    expect(result.affectedRows ?? 0).toBe(0)

    const names = await db.asUser(USER_A, () =>
      db.pg.query<{ name: string }>(`SELECT name FROM accounts WHERE name = 'hijacked'`),
    )
    expect(names.rows).toHaveLength(0)
  })

  it("refuses to let a user delete another user's row", async () => {
    const result = await db.asUser(USER_B, () => db.pg.query(`DELETE FROM transactions`))
    expect(result.affectedRows ?? 0).toBe(0)
    expect(await countAs(USER_A, 'transactions')).toBe(1)
  })
})

describe('cross-tenant foreign keys', () => {
  it("refuses to attach an entry to another user's transaction", async () => {
    // RLS hides A's transaction from B, but foreign-key checks run with RLS
    // bypassed. Without the composite (id, user_id) key, B could insert an
    // entry against A's transaction and unbalance A's ledger — invisible to B,
    // and breaking of A's writes. This is the test for that hole.
    const txnId = await db.asUser(USER_A, async () => {
      const r = await db.pg.query<{ id: string }>(`SELECT id FROM transactions LIMIT 1`)
      return r.rows[0]!.id
    })

    const accountsB = await seedAccounts(db, USER_B)

    await expect(
      db.asUser(USER_B, () =>
        db.pg.query(
          `INSERT INTO entries
             (user_id, transaction_id, account_id, amount_minor, currency, fx_rate_to_hkd, amount_hkd_minor)
           VALUES ($1, $2, $3, 100, 'HKD', 1, 100)`,
          [USER_B, txnId, accountsB.bank],
        ),
      ),
    ).rejects.toThrow(/entries_transaction_tenant_fk/)
  })

  it("refuses to book an entry against another user's account", async () => {
    const txnIdB = await db.asUser(USER_B, async () => {
      const r = await db.pg.query<{ id: string }>(
        `INSERT INTO transactions (user_id, occurred_at) VALUES ($1, now()) RETURNING id`,
        [USER_B],
      )
      return r.rows[0]!.id
    })

    await expect(
      db.asUser(USER_B, () =>
        db.pg.query(
          `INSERT INTO entries
             (user_id, transaction_id, account_id, amount_minor, currency, fx_rate_to_hkd, amount_hkd_minor)
           VALUES ($1, $2, $3, 100, 'HKD', 1, 100)`,
          [USER_B, txnIdB, accountsA.bank],
        ),
      ),
    ).rejects.toThrow(/entries_account_tenant_fk/)
  })
})
