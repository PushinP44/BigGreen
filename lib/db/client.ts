import 'server-only'

/**
 * Database client.
 *
 * Two drivers behind one interface:
 *
 *  - `DATABASE_URL` set → postgres.js against Supabase. The real thing.
 *  - unset → PGlite persisted under `.pglite/`, migrations applied on first
 *    access. Lets the app run end-to-end before a Supabase project exists,
 *    using the exact same migrations that ship.
 *
 * The PGlite path is development-only and refuses to start in production —
 * a local file database silently backing a deployed money tracker would be a
 * genuinely bad day.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'

const DEV_DATA_DIR = join(process.cwd(), '.pglite')
const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/**
 * Single dev identity. Real Supabase Auth arrives in P1; until then every row
 * is owned by this uuid so the RLS policies are exercised rather than bypassed.
 */
export const DEV_USER_ID = '00000000-0000-4000-8000-000000000001'

export interface QueryResult<T> {
  rows: T[]
  affectedRows?: number | undefined
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  /**
   * Run `fn` inside one database transaction.
   *
   * Not optional for anything that writes a ledger entry. The zero-sum
   * constraint trigger is DEFERRABLE INITIALLY DEFERRED, so it fires at COMMIT
   * — and with autocommit, every statement is its own COMMIT. Inserting a
   * transaction's entries one query at a time therefore trips the trigger on
   * the first entry, every time.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

/** Shared BEGIN/COMMIT/ROLLBACK wrapper — both drivers hold a single connection. */
function withTransaction(
  exec: (sql: string) => Promise<unknown>,
  self: () => Db,
): <T>(fn: (tx: Db) => Promise<T>) => Promise<T> {
  return async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    await exec('BEGIN')
    try {
      const result = await fn(self())
      await exec('COMMIT')
      return result
    } catch (error) {
      await exec('ROLLBACK')
      throw error
    }
  }
}

// ── Dev driver (PGlite) ─────────────────────────────────────────────────────

/**
 * Next.js dev reloads modules on every edit; without a global the app would
 * open a second PGlite instance against the same directory and lock it.
 */
const globalForDb = globalThis as unknown as { __bigGreenPglite?: Promise<PGlite> }

const AUTH_BOOTSTRAP = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
  END $$;

  CREATE SCHEMA IF NOT EXISTS auth;

  CREATE OR REPLACE FUNCTION auth.uid()
  RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
  $$;

  GRANT USAGE ON SCHEMA auth TO anon, authenticated;
`

async function applyMigrations(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "__migrations" (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `)

  const applied = await pg.query<{ name: string }>('SELECT name FROM "__migrations"')
  const done = new Set(applied.rows.map((r) => r.name))

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

  for (const file of files) {
    if (done.has(file)) continue
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    await pg.exec(sql)

    // Supabase grants these by default; reproduce them after the first
    // migration creates the tables, so RLS is what separates tenants.
    await pg.exec(`
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
    `)

    await pg.query('INSERT INTO "__migrations" (name) VALUES ($1)', [file])
  }
}

async function openDevDatabase(): Promise<PGlite> {
  // Dynamic so PGlite stays a devDependency and never enters a production
  // bundle — the production path throws before reaching here anyway.
  const { PGlite: Pg } = await import('@electric-sql/pglite')
  const pg = await Pg.create({ dataDir: DEV_DATA_DIR })
  await pg.exec(AUTH_BOOTSTRAP)
  await applyMigrations(pg)
  await seedDevData(pg)
  return pg
}

function devDatabase(): Promise<PGlite> {
  globalForDb.__bigGreenPglite ??= openDevDatabase()
  return globalForDb.__bigGreenPglite
}

/**
 * Accounts matching the real institution set (PLAN §7.1), plus the system
 * accounts the double-entry and FX policies need. Idempotent.
 */
async function seedDevData(pg: PGlite): Promise<void> {
  const existing = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM accounts WHERE user_id = $1',
    [DEV_USER_ID],
  )
  if ((existing.rows[0]?.n ?? 0) > 0) return

  // Three pools (PLAN rev 4): HKD across the HK banks and wallets, USD at ZA,
  // THB at Krung Thai. Foreign currency lives only in ZA and KTB.
  const seed: Array<[string, string, string, boolean, boolean, string | null, string | null]> = [
    // name, kind, currency, isLiquid, isOwn, institution, systemRole
    ['HSBC HKD', 'bank', 'HKD', true, true, 'hsbc', null],
    ['ZA Bank', 'bank', 'HKD', true, true, 'za', null],
    ['Mox', 'bank', 'HKD', true, true, 'mox', null],
    ['Octopus', 'ewallet', 'HKD', true, true, 'octopus', null],
    ['PayMe', 'ewallet', 'HKD', true, true, 'payme', null],
    ['HSBC Credit Card', 'credit_card', 'HKD', false, true, 'hsbc', null],
    ['ZA Bank USD', 'bank', 'USD', true, true, 'za', null],
    ['Krung Thai (KTB)', 'bank', 'THB', true, true, 'ktb', null],
    ['Expenses', 'expense', 'HKD', false, false, null, 'expense'],
    ['Income', 'income', 'HKD', false, false, null, 'income'],
    ['Opening Equity', 'equity', 'HKD', false, false, null, 'opening_equity'],
    ['FX Rounding', 'equity', 'HKD', false, false, null, 'fx_rounding'],
    ['FX Gain/Loss', 'expense', 'HKD', false, false, null, 'fx_gain_loss'],
  ]

  for (const [name, kind, currency, isLiquid, isOwn, institution, systemRole] of seed) {
    await pg.query(
      `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, institution, system_role)
       VALUES ($1, $2, $3::account_kind, $4, $5, $6, $7, $8)`,
      [DEV_USER_ID, name, kind, currency, isLiquid, isOwn, institution, systemRole],
    )
  }

  // `is_discretionary` drives the CAUTION band of the safety rule (PLAN §5),
  // so the split matters: it is "could I have skipped this?", not "was it
  // nice?". Rent and utilities are not discretionary however much you dislike
  // paying them.
  const categorySeed: Array<[string, boolean]> = [
    ['Food & Drink', true],
    ['Groceries', false],
    ['Transport', false],
    ['Rent', false],
    ['Utilities', false],
    ['Health', false],
    ['Shopping', true],
    ['Entertainment', true],
    ['Travel', true],
    ['Fees & Charges', false],
    ['Other', false],
  ]

  for (const [name, isDiscretionary] of categorySeed) {
    await pg.query(
      `INSERT INTO categories (user_id, name, is_discretionary) VALUES ($1, $2, $3)`,
      [DEV_USER_ID, name, isDiscretionary],
    )
  }

  // Placeholder rates so the multi-currency path is exercised before the
  // Frankfurter job exists (P1). Marked 'manual' — they are not real quotes.
  const today = new Date().toISOString().slice(0, 10)
  for (const [base, rate] of [
    ['USD', '7.83210000'],
    ['THB', '0.22415000'],
  ] as const) {
    await pg.query(
      `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
       VALUES ($1, $2, 'HKD', $3, $4, 'manual')
       ON CONFLICT DO NOTHING`,
      [DEV_USER_ID, base, today, rate],
    )
  }
}

// ── Public interface ────────────────────────────────────────────────────────

/**
 * A handle scoped to one user, with the RLS session context already set.
 * Every read and write in the app goes through this, so a missing policy shows
 * up as missing data rather than as a leak.
 */
export async function getDb(userId: string = DEV_USER_ID): Promise<Db> {
  const url = process.env.DATABASE_URL

  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DATABASE_URL is not set. The PGlite development database is never used in ' +
          'production — set DATABASE_URL to your Supabase connection string.',
      )
    }

    const pg = await devDatabase()
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
      transaction: withTransaction(
        (sql) => pg.exec(sql),
        () => db,
      ),
    }
    return db
  }

  // Supabase path. Lazily imported so the dev path never loads a pg driver.
  const { default: postgres } = await import('postgres')
  const sql = postgres(url, { max: 1, prepare: false })
  await sql`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, false)`

  const db: Db = {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = (await sql.unsafe(text, params as never[])) as unknown as T[]
      return { rows }
    },
    transaction: withTransaction(
      (text) => sql.unsafe(text),
      () => db,
    ),
  }
  return db
}
