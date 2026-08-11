/**
 * In-process Postgres for schema, migration and RLS tests.
 *
 * PLAN §13: PGlite rather than Docker. Tests run offline, in CI without a
 * service container, and each one gets a genuinely fresh database rather than a
 * truncated shared one.
 *
 * The Supabase auth surface RLS depends on (`auth.uid()`, the `anon` and
 * `authenticated` roles, default grants) does not exist in a bare Postgres, so
 * this module recreates it faithfully enough that a policy which passes here
 * behaves the same on Supabase.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { Db } from '@/lib/db/client'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/**
 * Mirrors Supabase's own `auth.uid()`: read the `sub` claim out of the JWT
 * claims GUC. Tests set that GUC instead of minting real JWTs.
 */
const AUTH_BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;

  CREATE SCHEMA IF NOT EXISTS auth;

  CREATE OR REPLACE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$
    SELECT NULLIF(
      current_setting('request.jwt.claims', true)::json ->> 'sub',
      ''
    )::uuid
  $$;

  GRANT USAGE ON SCHEMA auth TO anon, authenticated;
`

/**
 * Supabase grants table privileges to `anon` and `authenticated` by default;
 * RLS, not the grant, is what keeps tenants apart. Reproducing that here means
 * an RLS test proves the policy works — rather than passing because the role
 * happened to have no privileges at all.
 */
const SUPABASE_DEFAULT_GRANTS = `
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
`

export async function listMigrations(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR)
  return files.filter((f) => f.endsWith('.sql')).sort()
}

export async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), 'utf8')
}

export interface TestDb {
  readonly pg: PGlite
  /** Run `fn` with the session acting as `userId` through the RLS policies. */
  asUser<T>(userId: string, fn: () => Promise<T>): Promise<T>
  /** Run `fn` as an unauthenticated caller. */
  asAnon<T>(fn: () => Promise<T>): Promise<T>
  /** A `Db`-shaped handle, so application code can be tested against this database. */
  asDb(userId: string): Promise<Db>
  close(): Promise<void>
}

/**
 * Fresh database with every migration applied, in filename order — the same
 * order the Supabase CLI uses, so what passes here is what ships.
 */
export async function createTestDb(): Promise<TestDb> {
  const pg = await PGlite.create()

  await pg.exec(AUTH_BOOTSTRAP)

  const migrations = await listMigrations()
  if (migrations.length === 0) {
    throw new Error(`no migrations found in ${MIGRATIONS_DIR}`)
  }

  let grantsApplied = false
  for (const name of migrations) {
    await pg.exec(await readMigration(name))

    // Grants land after the tables exist but before the RLS migration, so that
    // migration's REVOKE statements act on real privileges — matching the
    // order of events on a real Supabase project.
    if (!grantsApplied) {
      await pg.exec(SUPABASE_DEFAULT_GRANTS)
      grantsApplied = true
    }
  }

  async function withRole<T>(role: string, claims: string | null, fn: () => Promise<T>): Promise<T> {
    await pg.query('SELECT set_config($1, $2, false)', ['request.jwt.claims', claims ?? ''])
    await pg.exec(`SET ROLE ${role};`)
    try {
      return await fn()
    } finally {
      await pg.exec('RESET ROLE;')
      await pg.query('SELECT set_config($1, $2, false)', ['request.jwt.claims', ''])
    }
  }

  async function asDb(userId: string): Promise<Db> {
    await pg.query('SELECT set_config($1, $2, false)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId }),
    ])
    await pg.exec('SET ROLE authenticated;')

    const db: Db = {
      async query<T>(sql: string, params: unknown[] = []) {
        const result = await pg.query<T>(sql, params)
        return { rows: result.rows, affectedRows: result.affectedRows }
      },
      async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        await pg.exec('BEGIN')
        try {
          const result = await fn(db)
          await pg.exec('COMMIT')
          return result
        } catch (error) {
          await pg.exec('ROLLBACK')
          throw error
        }
      },
    }
    return db
  }

  return {
    pg,
    asUser: (userId, fn) => withRole('authenticated', JSON.stringify({ sub: userId }), fn),
    asAnon: (fn) => withRole('anon', null, fn),
    asDb,
    close: () => pg.close(),
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export const USER_A = '11111111-1111-4111-8111-111111111111'
export const USER_B = '22222222-2222-4222-8222-222222222222'

export interface SeededAccounts {
  readonly bank: string
  readonly expense: string
  readonly income: string
  readonly fxRounding: string
}

/**
 * The minimum set of accounts a ledger needs: one you own, the two outside-world
 * counterparties, and the FX rounding sink.
 */
export async function seedAccounts(db: TestDb, userId: string): Promise<SeededAccounts> {
  return db.asUser(userId, async () => {
    const insert = async (
      name: string,
      kind: string,
      isLiquid: boolean,
      isOwn: boolean,
      systemRole: string | null,
    ): Promise<string> => {
      const result = await db.pg.query<{ id: string }>(
        `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, system_role)
         VALUES ($1, $2, $3::account_kind, 'HKD', $4, $5, $6)
         RETURNING id`,
        [userId, name, kind, isLiquid, isOwn, systemRole],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`failed to seed account ${name}`)
      return row.id
    }

    return {
      bank: await insert('HSBC HKD', 'bank', true, true, null),
      expense: await insert('Expenses', 'expense', false, false, 'expense'),
      income: await insert('Income', 'income', false, false, 'income'),
      fxRounding: await insert('FX Rounding', 'equity', false, false, 'fx_rounding'),
    }
  })
}

/** Insert a balanced two-entry transaction. Returns the transaction id. */
export async function insertBalancedTransaction(
  db: TestDb,
  userId: string,
  opts: {
    debitAccountId: string
    creditAccountId: string
    amountHkdMinor: bigint
    occurredAt?: string
    status?: string
  },
): Promise<string> {
  return db.asUser(userId, async () => {
    const txn = await db.pg.query<{ id: string }>(
      `INSERT INTO transactions (user_id, occurred_at, status, description)
       VALUES ($1, $2, $3::transaction_status, 'test')
       RETURNING id`,
      [userId, opts.occurredAt ?? '2026-08-11T04:00:00Z', opts.status ?? 'posted'],
    )
    const id = txn.rows[0]?.id
    if (!id) throw new Error('failed to insert transaction')

    const amount = opts.amountHkdMinor.toString()
    await db.pg.query(
      `INSERT INTO entries
         (user_id, transaction_id, account_id, amount_minor, currency, fx_rate_to_hkd, amount_hkd_minor)
       VALUES
         ($1, $2, $3, $4, 'HKD', 1, $4),
         ($1, $2, $5, $6, 'HKD', 1, $6)`,
      [userId, id, opts.debitAccountId, amount, opts.creditAccountId, `-${amount}`],
    )

    return id
  })
}
