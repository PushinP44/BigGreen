import 'server-only'

/**
 * Ledger read model.
 *
 * Loads rows and hands them to `lib/domain/balances.ts`, which decides what
 * they mean. Nothing here computes a figure the user acts on — a read model
 * that starts doing arithmetic is a domain rule that escaped its tests.
 *
 * Loading every entry is deliberate: this is a single-user tracker where the
 * whole ledger is a few thousand rows, and one in-memory pass is both simpler
 * and more honest than a dozen SQL aggregates that can each drift from the
 * pure functions they are meant to mirror.
 */

import type { Db } from '@/lib/db/client'
import type {
  AccountSnapshot,
  CategorySnapshot,
  EntrySnapshot,
} from '@/lib/domain/balances'
import { isCurrency, type Currency } from '@/lib/domain/money'

export interface LedgerSnapshot {
  readonly accounts: AccountSnapshot[]
  readonly entries: EntrySnapshot[]
  readonly categories: CategorySnapshot[]
}

function currencyOrThrow(value: string, context: string): Currency {
  const trimmed = value.trim()
  if (!isCurrency(trimmed)) {
    throw new Error(`${context} has unsupported currency ${trimmed}`)
  }
  return trimmed
}

export async function loadLedgerSnapshot(db: Db): Promise<LedgerSnapshot> {
  const [accountRows, entryRows, categoryRows] = await Promise.all([
    db.query<{
      id: string
      kind: string
      currency: string
      is_liquid: boolean
      is_own: boolean
      opening_balance_minor: string
      credit_limit_minor: string | null
      statement_day: number | null
      payment_due_day: number | null
      apr_bps: number | null
      min_payment_pct_bps: number | null
      min_payment_floor_minor: string | null
    }>(
      `SELECT id, kind::text AS kind, currency, is_liquid, is_own, opening_balance_minor,
              credit_limit_minor, statement_day, payment_due_day, apr_bps,
              min_payment_pct_bps, min_payment_floor_minor
         FROM accounts WHERE archived_at IS NULL`,
    ),
    db.query<{
      transaction_id: string
      account_id: string
      amount_minor: string
      currency: string
      amount_hkd_minor: string
      occurred_at: string
      status: string
      category_id: string | null
      is_fx_residual: boolean
    }>(
      `SELECT e.transaction_id, e.account_id, e.amount_minor, e.currency,
              e.amount_hkd_minor, t.occurred_at, t.status::text AS status,
              t.category_id, e.is_fx_residual
         FROM entries e
         JOIN transactions t ON t.id = e.transaction_id`,
    ),
    db.query<{ id: string; name: string; is_discretionary: boolean }>(
      `SELECT id, name, is_discretionary FROM categories ORDER BY name`,
    ),
  ])

  return {
    accounts: accountRows.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      currency: currencyOrThrow(row.currency, `account ${row.id}`),
      isLiquid: row.is_liquid,
      isOwn: row.is_own,
      openingBalanceMinor: BigInt(row.opening_balance_minor),
      // Only attached to cards. Absent means the safety rule falls back to the
      // conservative whole-balance model rather than inventing a cycle.
      card:
        row.kind === 'credit_card'
          ? {
              statementDay: row.statement_day,
              paymentDueDay: row.payment_due_day,
              creditLimitMinor:
                row.credit_limit_minor === null ? null : BigInt(row.credit_limit_minor),
              aprBps: row.apr_bps,
              minPaymentPctBps: row.min_payment_pct_bps,
              minPaymentFloorMinor:
                row.min_payment_floor_minor === null
                  ? null
                  : BigInt(row.min_payment_floor_minor),
            }
          : undefined,
    })),
    entries: entryRows.rows.map((row) => ({
      transactionId: row.transaction_id,
      accountId: row.account_id,
      amountMinor: BigInt(row.amount_minor),
      currency: currencyOrThrow(row.currency, `entry on ${row.transaction_id}`),
      amountHkdMinor: BigInt(row.amount_hkd_minor),
      occurredAt: new Date(row.occurred_at),
      status: row.status as EntrySnapshot['status'],
      categoryId: row.category_id,
      isFxResidual: row.is_fx_residual,
    })),
    categories: categoryRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isDiscretionary: row.is_discretionary,
    })),
  }
}

// ── Transaction list ────────────────────────────────────────────────────────

export interface TransactionRow {
  readonly id: string
  readonly occurredAt: Date
  readonly description: string | null
  readonly status: string
  readonly categoryName: string | null
  /** Signed, from your side of the boundary: negative is money leaving. */
  readonly ownedDeltaHkdMinor: bigint
  /** The account leg the user recognises, with its own currency amount. */
  readonly accountName: string
  readonly accountCurrency: Currency
  readonly nativeMinor: bigint
  readonly isTransfer: boolean
}

export async function listRecentTransactions(db: Db, limit = 25): Promise<TransactionRow[]> {
  const result = await db.query<{
    id: string
    occurred_at: string
    description: string | null
    status: string
    category_name: string | null
    owned_delta: string
    account_name: string
    account_currency: string
    native_minor: string
    owned_leg_count: string
  }>(
    `
    WITH legs AS (
      SELECT
        t.id,
        t.occurred_at,
        t.description,
        t.status::text                                    AS status,
        c.name                                            AS category_name,
        SUM(e.amount_hkd_minor) FILTER (WHERE a.is_own)   AS owned_delta,
        COUNT(*)      FILTER (WHERE a.is_own)             AS owned_leg_count
      FROM transactions t
      JOIN entries  e ON e.transaction_id = t.id
      JOIN accounts a ON a.id = e.account_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.status <> 'void'
      GROUP BY t.id, c.name
    ),
    -- The leg the user thinks of as "the account", picked deterministically:
    -- the largest owned movement.
    principal AS (
      SELECT DISTINCT ON (e.transaction_id)
        e.transaction_id, a.name AS account_name, a.currency AS account_currency,
        e.amount_minor AS native_minor
      FROM entries e
      JOIN accounts a ON a.id = e.account_id
      WHERE a.is_own
      ORDER BY e.transaction_id, abs(e.amount_hkd_minor) DESC, a.name
    )
    SELECT legs.*, principal.account_name, principal.account_currency, principal.native_minor
      FROM legs
      JOIN principal ON principal.transaction_id = legs.id
     ORDER BY legs.occurred_at DESC
     LIMIT $1
    `,
    [limit],
  )

  return result.rows.map((row) => ({
    id: row.id,
    occurredAt: new Date(row.occurred_at),
    description: row.description,
    status: row.status,
    categoryName: row.category_name,
    ownedDeltaHkdMinor: BigInt(row.owned_delta ?? '0'),
    accountName: row.account_name,
    accountCurrency: currencyOrThrow(row.account_currency, `transaction ${row.id}`),
    nativeMinor: BigInt(row.native_minor),
    // Two owned legs and no net movement across the boundary: money you moved
    // between your own accounts.
    isTransfer: Number(row.owned_leg_count) >= 2 && BigInt(row.owned_delta ?? '0') === 0n,
  }))
}

export interface FxStatus {
  readonly currency: Currency
  readonly rate: string
  readonly asOf: string
  readonly source: string
}

export async function listFxStatus(db: Db): Promise<FxStatus[]> {
  const result = await db.query<{
    base: string
    rate: string
    as_of: string
    source: string
  }>(
    `SELECT DISTINCT ON (base) base, rate, as_of::text AS as_of, source
       FROM fx_rates WHERE quote = 'HKD' ORDER BY base, as_of DESC`,
  )

  return result.rows.map((row) => ({
    currency: currencyOrThrow(row.base, 'fx rate'),
    rate: row.rate,
    asOf: row.as_of,
    source: row.source,
  }))
}

export async function listCategories(db: Db): Promise<CategorySnapshot[]> {
  const result = await db.query<{ id: string; name: string; is_discretionary: boolean }>(
    'SELECT id, name, is_discretionary FROM categories ORDER BY name',
  )
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    isDiscretionary: row.is_discretionary,
  }))
}

/**
 * Emails the parser was not confident enough to post, awaiting a decision in
 * `/review`. An unbounded queue means a parser is broken, so the count belongs
 * somewhere you cannot miss it — the nav badge.
 *
 * Previously this was raw SQL inlined halfway down the dashboard component.
 * It has two callers now, and reads belong here regardless.
 */
export async function countPendingTransactions(db: Db): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM transactions WHERE status = 'pending'`,
  )
  return result.rows[0]?.n ?? 0
}
