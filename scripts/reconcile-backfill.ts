/**
 * Reconcile account balances after backfilling historical email-ingested
 * transactions, so today's balance total stays exactly what you set it to.
 *
 * Every transaction — backfilled or live — is a normal double-entry
 * transaction that moves the account balance by design (PLAN §2); there is
 * no "record for history but don't touch the balance" mode. Backfilling
 * spending that already happened before your opening balance was set would
 * otherwise pull today's total down by however much gets backfilled, since
 * that spending is already baked into the number you entered.
 *
 * This restores it the other way: for each account, sum every posted,
 * email-sourced entry dated before the cutoff, and shift
 * opening_balance_minor backward by exactly that amount. The stored opening
 * balance changes — it now represents the balance before the backfilled
 * history rather than today — but opening + all entries still adds up to
 * the same total you saw before running this.
 *
 * Dry-run by default; pass --apply to write. Run once, after everything from
 * the backfill has settled: auto-posted transactions immediately, anything
 * that landed in /review only once you have reviewed and confirmed it.
 * Refuses to run twice for the same cutoff (recorded in rule_settings) —
 * re-running would sum the same already-compensated entries again and
 * double-adjust.
 *
 *   pnpm db:reconcile-backfill you@example.com 2026-06-16
 *   pnpm db:reconcile-backfill you@example.com 2026-06-16 --apply
 */

import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { fromLocalDate } from '../lib/domain/clock.ts'
import { formatMoney, isCurrency, money } from '../lib/domain/money.ts'

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
const cutoffRaw = process.argv[3]
const apply = process.argv.includes('--apply')

const RECONCILE_KEY = 'email_backfill_reconciled'

if (!email || !cutoffRaw) {
  console.error('Usage: pnpm db:reconcile-backfill <your-email> <cutoff YYYY-MM-DD> [--apply]')
  process.exit(1)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffRaw)) {
  console.error(`Cutoff must be YYYY-MM-DD, got ${JSON.stringify(cutoffRaw)}.`)
  process.exit(1)
}
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

// Midnight Asia/Hong_Kong on the cutoff date, as a UTC instant — same
// bucketing rule as everywhere else in the app (CLAUDE.md non-negotiable #4).
const cutoffInstant = fromLocalDate(cutoffRaw)

interface AccountDelta {
  readonly id: string
  readonly name: string
  readonly currency: string
  readonly openingBalanceMinor: bigint
  readonly backfillNetMinor: bigint
}

const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 20 })

try {
  const users = await sql`SELECT id, email FROM auth.users WHERE email = ${email}`
  const user = users[0]

  if (!user) {
    console.error(`No signed-in user found for ${email}.`)
    process.exit(1)
  }

  const already = await sql`
    SELECT value_json FROM rule_settings
    WHERE user_id = ${user.id}::uuid AND key = ${RECONCILE_KEY}
  `
  const alreadyDone = already.some((row) => {
    const parsed = JSON.parse(String(row.value_json)) as { cutoff?: string }
    return parsed.cutoff === cutoffRaw
  })
  if (alreadyDone) {
    console.log(
      `Already reconciled for cutoff ${cutoffRaw}. Re-running would sum the same ` +
        `already-compensated entries again — use a later cutoff if there is newly-confirmed ` +
        `history to fold in.`,
    )
    process.exit(0)
  }

  const rows = await sql`
    SELECT a.id, a.name, a.currency, a.opening_balance_minor::text AS opening_balance_minor,
           COALESCE(SUM(e.amount_minor) FILTER (WHERE t.id IS NOT NULL), 0)::text AS backfill_net_minor
      FROM accounts a
      LEFT JOIN entries e ON e.account_id = a.id
      LEFT JOIN transactions t ON t.id = e.transaction_id
       AND t.source = 'email' AND t.status = 'posted' AND t.occurred_at < ${cutoffInstant}
     WHERE a.user_id = ${user.id}::uuid AND a.is_own AND a.archived_at IS NULL
     GROUP BY a.id, a.name, a.currency, a.opening_balance_minor
     ORDER BY a.currency, a.name
  `

  const deltas: AccountDelta[] = rows
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      currency: String(row.currency).trim(),
      openingBalanceMinor: BigInt(String(row.opening_balance_minor)),
      backfillNetMinor: BigInt(String(row.backfill_net_minor)),
    }))
    .filter((d) => d.backfillNetMinor !== 0n)

  if (deltas.length === 0) {
    console.log(`Nothing to reconcile — no posted, email-sourced transactions before ${cutoffRaw}.`)
    process.exit(0)
  }

  console.log(`${apply ? 'Applying' : 'Preview — pass --apply to write'}, cutoff ${cutoffRaw}:\n`)

  for (const d of deltas) {
    const fmt = (m: bigint) =>
      isCurrency(d.currency) ? formatMoney(money(m, d.currency)) : `${m} ${d.currency}`
    const newOpening = d.openingBalanceMinor - d.backfillNetMinor
    console.log(
      `  ${d.name.padEnd(24)} backfilled net ${fmt(d.backfillNetMinor).padStart(14)}   ` +
        `opening ${fmt(d.openingBalanceMinor)} -> ${fmt(newOpening)}`,
    )
  }

  if (!apply) {
    console.log('\nDry run only — nothing written. Re-run with --apply to commit.')
    process.exit(0)
  }

  await sql.begin(async (tx) => {
    for (const d of deltas) {
      await tx`
        UPDATE accounts
           SET opening_balance_minor = opening_balance_minor - ${d.backfillNetMinor.toString()}
         WHERE id = ${d.id}::uuid
      `
    }

    await tx`
      INSERT INTO rule_settings (user_id, key, value_json)
      VALUES (
        ${user.id}::uuid,
        ${RECONCILE_KEY},
        ${JSON.stringify({
          cutoff: cutoffRaw,
          accounts: deltas.map((d) => ({ id: d.id, backfillNetMinor: d.backfillNetMinor.toString() })),
        })}
      )
    `
  })

  console.log(`\nApplied. ${deltas.length} account(s) adjusted; today's totals are unchanged.`)
} catch (error) {
  console.error('Reconcile failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
