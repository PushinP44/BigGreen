/**
 * Verifies the query shape scripts/reconcile-backfill.ts reconciles against:
 * which entries a backfill should sum (posted, email-sourced, before the
 * cutoff) and that shifting opening_balance_minor by that sum leaves the
 * account's derived total exactly where it was before the backfill landed.
 *
 * The script itself connects with the `postgres` package directly rather
 * than through `Db` (it is a standalone maintenance script, same shape as
 * scripts/claim.ts), so this exercises the identical SQL against the
 * project's own PGlite harness instead of importing the script — keep the
 * WHERE/JOIN conditions here in sync with the script if either changes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

/**
 * A posted-by-default, balanced transaction against the seeded bank account,
 * with a controllable source/status/date. `amountMinor` is signed from the
 * bank account's own point of view: positive debits it (a spend), negative
 * credits it (income) — the counterparty leg is whatever balances that,
 * signed the opposite way via real BigInt negation rather than string
 * concatenation (naive `-${amount}` produces "--8000" for an already-negative
 * amount).
 */
async function insertTransaction(opts: {
  amountMinor: bigint
  source?: string
  status?: string
  occurredAt: string
}): Promise<void> {
  const txn = await db.query<{ id: string }>(
    `INSERT INTO transactions (user_id, occurred_at, status, source, description)
     VALUES ($1, $2, $3::transaction_status, $4::transaction_source, 'test')
     RETURNING id`,
    [USER_A, opts.occurredAt, opts.status ?? 'posted', opts.source ?? 'email'],
  )
  const id = txn.rows[0]?.id
  if (!id) throw new Error('failed to insert transaction')

  const bankAmount = (-opts.amountMinor).toString()
  const counterpartyAmount = opts.amountMinor.toString()
  await db.query(
    `INSERT INTO entries
       (user_id, transaction_id, account_id, amount_minor, currency, fx_rate_to_hkd, amount_hkd_minor)
     VALUES
       ($1, $2, $3, $4, 'HKD', 1, $4),
       ($1, $2, $5, $6, 'HKD', 1, $6)`,
    [USER_A, id, accounts.bank, bankAmount, accounts.expense, counterpartyAmount],
  )
}

/** scripts/reconcile-backfill.ts's own SELECT, scoped to one account. */
async function computeBackfillNet(cutoffIso: string): Promise<bigint> {
  const result = await db.query<{ backfill_net_minor: string }>(
    `SELECT COALESCE(SUM(e.amount_minor) FILTER (WHERE t.id IS NOT NULL), 0)::text AS backfill_net_minor
       FROM accounts a
       LEFT JOIN entries e ON e.account_id = a.id
       LEFT JOIN transactions t ON t.id = e.transaction_id
        AND t.source = 'email' AND t.status = 'posted' AND t.occurred_at < $1
      WHERE a.id = $2
      GROUP BY a.id`,
    [cutoffIso, accounts.bank],
  )
  return BigInt(result.rows[0]?.backfill_net_minor ?? '0')
}

async function derivedTotal(): Promise<bigint> {
  const result = await db.query<{ total: string }>(
    `SELECT (a.opening_balance_minor
              + COALESCE(SUM(e.amount_minor) FILTER (WHERE e.currency = a.currency), 0))::text AS total
       FROM accounts a
       LEFT JOIN entries e ON e.account_id = a.id
        AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = e.transaction_id AND t.status = 'posted')
      WHERE a.id = $1
      GROUP BY a.id`,
    [accounts.bank],
  )
  const total = result.rows[0]?.total
  if (total === undefined) throw new Error('account not found')
  return BigInt(total)
}

describe('backfill net query', () => {
  it('sums posted, email-sourced entries dated before the cutoff', async () => {
    await insertTransaction({ amountMinor: 20000n, occurredAt: '2026-06-01T00:00:00Z' })
    await insertTransaction({ amountMinor: 5000n, occurredAt: '2026-06-15T00:00:00Z' })

    expect(await computeBackfillNet('2026-06-16T00:00:00Z')).toBe(-25000n)
  })

  it('excludes entries from other sources', async () => {
    await insertTransaction({
      amountMinor: 20000n,
      source: 'manual',
      occurredAt: '2026-06-01T00:00:00Z',
    })
    expect(await computeBackfillNet('2026-06-16T00:00:00Z')).toBe(0n)
  })

  it('excludes pending transactions — nothing not yet reviewed should move the balance', async () => {
    await insertTransaction({
      amountMinor: 20000n,
      status: 'pending',
      occurredAt: '2026-06-01T00:00:00Z',
    })
    expect(await computeBackfillNet('2026-06-16T00:00:00Z')).toBe(0n)
  })

  it('excludes entries on or after the cutoff', async () => {
    await insertTransaction({ amountMinor: 20000n, occurredAt: '2026-06-16T00:00:00Z' })
    expect(await computeBackfillNet('2026-06-16T00:00:00Z')).toBe(0n)
  })

  it('is zero when there is nothing to reconcile', async () => {
    expect(await computeBackfillNet('2026-06-16T00:00:00Z')).toBe(0n)
  })

  it('discriminates correctly when qualifying and non-qualifying entries are mixed together', async () => {
    // Two that count...
    await insertTransaction({ amountMinor: 20000n, occurredAt: '2026-06-01T00:00:00Z' })
    await insertTransaction({ amountMinor: 5000n, occurredAt: '2026-06-15T00:00:00Z' })
    // ...three that must not, each for a different reason.
    await insertTransaction({
      amountMinor: 99900n,
      source: 'manual',
      occurredAt: '2026-06-02T00:00:00Z',
    })
    await insertTransaction({
      amountMinor: 88800n,
      status: 'pending',
      occurredAt: '2026-06-03T00:00:00Z',
    })
    await insertTransaction({ amountMinor: 77700n, occurredAt: '2026-06-20T00:00:00Z' })

    expect(await computeBackfillNet('2026-06-16T00:00:00Z')).toBe(-25000n)
  })
})

describe('reconciliation preserves the derived total', () => {
  it('shifting opening balance by the computed net restores the pre-backfill total exactly', async () => {
    await db.query(`UPDATE accounts SET opening_balance_minor = $1 WHERE id = $2`, [
      '300000',
      accounts.bank,
    ])
    const before = await derivedTotal()

    // Backfill lands: two historical spends the opening balance already
    // implicitly accounted for.
    await insertTransaction({ amountMinor: 20000n, occurredAt: '2026-06-01T00:00:00Z' })
    await insertTransaction({ amountMinor: 5000n, occurredAt: '2026-06-15T00:00:00Z' })

    // Confirms the problem this script exists to fix: left alone, the
    // backfill silently pulls the derived total down.
    expect(await derivedTotal()).toBe(before - 25000n)

    const net = await computeBackfillNet('2026-06-16T00:00:00Z')
    await db.query(
      `UPDATE accounts SET opening_balance_minor = opening_balance_minor - $1 WHERE id = $2`,
      [net.toString(), accounts.bank],
    )

    expect(await derivedTotal()).toBe(before)
  })

  it('a mixed batch of income and spend nets correctly', async () => {
    await db.query(`UPDATE accounts SET opening_balance_minor = $1 WHERE id = $2`, [
      '300000',
      accounts.bank,
    ])
    const before = await derivedTotal()

    await insertTransaction({ amountMinor: 20000n, occurredAt: '2026-06-01T00:00:00Z' }) // spend
    await insertTransaction({ amountMinor: -8000n, occurredAt: '2026-06-05T00:00:00Z' }) // income (negative "spend" = credit to bank)

    const net = await computeBackfillNet('2026-06-16T00:00:00Z')
    expect(net).toBe(-12000n) // net spend of 120.00 after the 80.00 credit

    await db.query(
      `UPDATE accounts SET opening_balance_minor = opening_balance_minor - $1 WHERE id = $2`,
      [net.toString(), accounts.bank],
    )
    expect(await derivedTotal()).toBe(before)
  })
})
