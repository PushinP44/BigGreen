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
// Type-only, so this does not pull the driver into the dev bundle.
import type { Sql, TransactionSql } from 'postgres'
import { APP_USER_ID, seedInitialData } from './seed'

const DEV_DATA_DIR = join(process.cwd(), '.pglite')
const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Re-exported for callers that already import from this module. */
export const DEV_USER_ID = APP_USER_ID

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
const globalForDb = globalThis as unknown as {
  __bigGreenPglite?: Promise<PGlite>
  __bigGreenPg?: Sql
}

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
 * Seed the development database from the shared definition in `seed.ts`, so
 * local and Supabase cannot drift apart. Idempotent.
 */
async function seedDevData(pg: PGlite): Promise<void> {
  await seedInitialData(
    {
      async query(sql: string, params: unknown[] = []) {
        const result = await pg.query<Record<string, unknown>>(sql, params)
        return { rows: result.rows }
      },
    },
    DEV_USER_ID,
  )

  // Dev-only placeholder rates, so the multi-currency path has something to
  // work with offline. Deliberately not part of the shared seed — invented
  // rates have no business in the database that holds real balances.
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

// ── Supabase driver ─────────────────────────────────────────────────────────

async function createPgClient(url: string): Promise<Sql> {
  const { default: postgres } = await import('postgres')
  return postgres(url, {
    // Safe to pool: every statement runs in its own transaction and re-applies
    // its role with SET LOCAL, so no connection can carry privileges or claims
    // over to the next caller.
    max: 5,
    // Required by Supabase's transaction-mode pooler, harmless in session mode.
    prepare: false,
    idle_timeout: 20,
  })
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
  //
  // One client for the whole process, not one per request. `getDb()` is called
  // on every render, and postgres.js clients hold their connections open until
  // explicitly ended — creating one per call leaks a connection each time and
  // exhausts the Supabase pooler (pool_size 15) within a dozen page loads.
  // The global survives Next's dev-mode module reloading, same as PGlite above.
  const sql = (globalForDb.__bigGreenPg ??= await createPgClient(url))
  const claims = JSON.stringify({ sub: userId })

  /**
   * Every statement runs inside a transaction that drops to the `authenticated`
   * role first.
   *
   * This connects as `postgres`, and a Postgres superuser BYPASSES row-level
   * security outright — so without the `SET LOCAL ROLE` below, every policy in
   * migration 0001 is inert and the RLS test suite is proving something about a
   * configuration that never runs. `SET LOCAL` (rather than a session-wide
   * `SET`) is what makes it survive postgres.js transparently reconnecting: a
   * dropped connection cannot silently restore superuser privileges mid-request,
   * because the role is re-applied inside each transaction.
   *
   * Cost is one round trip per query. For a single-user tracker doing a handful
   * of queries per page that is not worth optimising away, and certainly not
   * worth trading RLS for.
   */
  const enterAuthenticated = async (tx: TransactionSql) => {
    await tx`SELECT set_config('request.jwt.claims', ${claims}, true)`
    await tx`SET LOCAL ROLE authenticated`
  }

  const db: Db = {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await sql.begin(async (tx) => {
        await enterAuthenticated(tx)
        return tx.unsafe(text, params as never[])
      })
      return { rows: rows as unknown as T[] }
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // One transaction for the whole callback — nesting `query`'s own
      // transaction inside this would turn each statement into a savepoint and
      // defeat the deferred zero-sum trigger, which only fires at COMMIT.
      return sql.begin(async (tx) => {
        await enterAuthenticated(tx)
        const scoped: Db = {
          async query<R>(text: string, params: unknown[] = []) {
            const rows = await tx.unsafe(text, params as never[])
            return { rows: rows as unknown as R[] }
          },
          // Already inside a transaction; running the callback directly keeps
          // the single COMMIT the trigger depends on.
          transaction: (inner) => inner(scoped),
        }
        return fn(scoped)
      }) as T
    },
  }

  return db
}
