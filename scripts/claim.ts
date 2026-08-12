/**
 * Reassign the pre-auth data to a real signed-in account.
 *
 * Everything created before Supabase Auth existed belongs to the fixed
 * development uuid. Signing in with a real account produces a different uuid,
 * and RLS then correctly shows that account nothing — your banks, card terms
 * and settings are all still there, just owned by someone who no longer signs
 * in.
 *
 * Run once, after signing in for the first time:
 *
 *   pnpm db:claim you@example.com
 *
 * Idempotent, and refuses rather than merges if the target account already has
 * data of its own — silently combining two ledgers would be far worse than
 * stopping.
 */

import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { APP_USER_ID } from '../lib/db/seed.ts'

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
const email = process.argv[2]

if (!email) {
  console.error('Usage: pnpm db:claim <your-email>')
  process.exit(1)
}
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

// Tables carrying a user_id. `entries` and `transactions` are updated together
// so the zero-sum trigger never sees a half-moved transaction.
const TABLES = [
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

const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 20 })

try {
  const users = await sql`SELECT id, email FROM auth.users WHERE email = ${email}`
  const target = users[0]

  if (!target) {
    console.error(
      `No account found for ${email}. Sign in through the app once first — the account is ` +
        `created by that first sign-in.`,
    )
    process.exit(1)
  }

  if (target.id === APP_USER_ID) {
    console.log('That account already owns the data. Nothing to do.')
    process.exit(0)
  }

  const [existingRow] = await sql`
    SELECT count(*)::int AS n FROM accounts WHERE user_id = ${target.id}::uuid
  `
  const [legacyRow] = await sql`
    SELECT count(*)::int AS n FROM accounts WHERE user_id = ${APP_USER_ID}::uuid
  `

  const existing = existingRow?.n ?? 0
  const legacy = legacyRow?.n ?? 0

  if (legacy === 0) {
    console.log('No pre-auth data to claim. Nothing to do.')
    process.exit(0)
  }

  // Provisioning at sign-in creates five system accounts. More than that means
  // the account has been used, and merging two ledgers is not something to do
  // implicitly.
  if (existing > 5) {
    console.error(
      `${email} already has ${existing} accounts of its own. Refusing to merge two ledgers — ` +
        `sort out which one you want to keep first.`,
    )
    process.exit(1)
  }

  await sql.begin(async (tx) => {
    // Remove the system accounts provisioned at sign-in, so the claimed ones do
    // not collide with them on the unique system_role index.
    await tx`DELETE FROM accounts WHERE user_id = ${target.id}::uuid AND system_role IS NOT NULL`
    await tx`DELETE FROM categories WHERE user_id = ${target.id}::uuid`

    for (const table of TABLES) {
      await tx.unsafe(`UPDATE ${table} SET user_id = $1 WHERE user_id = $2`, [
        target.id,
        APP_USER_ID,
      ])
    }
  })

  const [accountsRow] = await sql`
    SELECT count(*)::int AS n FROM accounts WHERE user_id = ${target.id}::uuid
  `
  const [txnsRow] = await sql`
    SELECT count(*)::int AS n FROM transactions WHERE user_id = ${target.id}::uuid
  `

  console.log(`Claimed by ${email}: ${accountsRow?.n ?? 0} accounts, ${txnsRow?.n ?? 0} transactions.`)
} catch (error) {
  console.error('Claim failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
