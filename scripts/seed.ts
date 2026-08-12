/**
 * Seed a Supabase database with the initial accounts and categories.
 *
 * Run with `pnpm db:seed`. Idempotent — running it twice is a no-op.
 *
 * Deliberately connects as `authenticated` rather than `postgres`. Seeding as a
 * superuser would bypass RLS and happily write rows the app could never read
 * back; doing it through the policies proves the seed is actually reachable.
 */

import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { APP_USER_ID, seedInitialData } from '../lib/db/seed.ts'

function loadEnv(path = '.env.local'): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
      .map((line) => {
        const i = line.indexOf('=')
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
      }),
  )
}

const env = { ...loadEnv(), ...process.env }
const url = env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Fill in .env.local first.')
  process.exit(1)
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20 })
const claims = JSON.stringify({ sub: APP_USER_ID })

try {
  const result = await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${claims}, true)`
    await tx`SET LOCAL ROLE authenticated`

    return seedInitialData(
      {
        async query(text: string, params: unknown[] = []) {
          const rows = await tx.unsafe(text, params as never[])
          return { rows: rows as unknown as Array<Record<string, unknown>> }
        },
      },
      APP_USER_ID,
    )
  })

  if (result.accountsCreated === 0) {
    console.log('Already seeded — nothing to do.')
  } else {
    console.log(
      `Seeded ${result.accountsCreated} accounts and ${result.categoriesCreated} categories.`,
    )
  }
} catch (error) {
  console.error('Seed failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
