import 'server-only'

/**
 * Account read model.
 *
 * Read models query; they do not decide anything. Every rule that produces a
 * verdict or a number the user acts on lives in `lib/domain/` as a pure
 * function (PLAN §2).
 */

import type { Db } from '@/lib/db/client'
import { BASE_CURRENCY, type Currency, isCurrency } from '@/lib/domain/money'

export interface AccountBalance {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly currency: Currency
  readonly institution: string | null
  readonly isLiquid: boolean
  readonly isOwn: boolean
  /**
   * In the account's own currency, counting only entries actually denominated
   * in it. Summing raw minor units across currencies would produce a number
   * that is not money in any currency — 1000.50 THB rendered as HK$1,000.50.
   */
  readonly balanceMinor: bigint
  /** Converted at each entry's frozen rate, so it is a historical fact. */
  readonly balanceHkdMinor: bigint
  /**
   * Entries in a currency other than the account's own. Non-zero on the shared
   * system accounts (Expenses, Income), where `balanceMinor` is therefore a
   * partial figure and `balanceHkdMinor` is the one to show.
   */
  readonly foreignEntryCount: number
}

interface AccountRow {
  id: string
  name: string
  kind: string
  currency: string
  institution: string | null
  is_liquid: boolean
  is_own: boolean
  balance_minor: string | number
  balance_hkd_minor: string | number
  foreign_entry_count: string | number
}

/** Postgres returns int8 as a string to avoid precision loss. Keep it that way. */
function toBigInt(value: string | number | null): bigint {
  if (value === null) return 0n
  return BigInt(String(value))
}

export async function listAccountBalances(db: Db): Promise<AccountBalance[]> {
  const result = await db.query<AccountRow>(`
    SELECT
      a.id,
      a.name,
      a.kind::text AS kind,
      a.currency,
      a.institution,
      a.is_liquid,
      a.is_own,
      a.opening_balance_minor
        + COALESCE(SUM(e.amount_minor) FILTER (WHERE e.currency = a.currency), 0)
                                                                     AS balance_minor,
      COALESCE(SUM(e.amount_hkd_minor), 0)                           AS balance_hkd_minor,
      COUNT(e.id) FILTER (WHERE e.currency <> a.currency)            AS foreign_entry_count
    FROM accounts a
    LEFT JOIN entries e
      ON e.account_id = a.id
     AND EXISTS (
           SELECT 1 FROM transactions t
            WHERE t.id = e.transaction_id
              AND t.status = 'posted'
         )
    WHERE a.archived_at IS NULL
    GROUP BY a.id
    ORDER BY a.is_own DESC, a.kind, a.name
  `)

  return result.rows.map((row) => {
    if (!isCurrency(row.currency)) {
      // A currency the app does not know how to round is not something to
      // guess at — the CHECK constraint should have made this unreachable.
      throw new Error(`account ${row.id} has unsupported currency ${row.currency}`)
    }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      currency: row.currency,
      institution: row.institution,
      isLiquid: row.is_liquid,
      isOwn: row.is_own,
      balanceMinor: toBigInt(row.balance_minor),
      balanceHkdMinor: toBigInt(row.balance_hkd_minor),
      foreignEntryCount: Number(row.foreign_entry_count ?? 0),
    }
  })
}

/**
 * Σ balances of accounts that are both liquid and owned — the `liquid` term of
 * the safety rule (PLAN §5). The rest of that rule arrives in P2.
 */
export function liquidTotalHkdMinor(accounts: readonly AccountBalance[]): bigint {
  let total = 0n
  for (const account of accounts) {
    if (account.isLiquid && account.isOwn) total += account.balanceHkdMinor
  }
  return total
}

export async function findSystemAccountId(db: Db, systemRole: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'SELECT id FROM accounts WHERE system_role = $1 LIMIT 1',
    [systemRole],
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error(`system account "${systemRole}" is missing`)
  return id
}

export async function rateTableFor(db: Db): Promise<Record<string, string>> {
  const result = await db.query<{ base: string; rate: string }>(`
    SELECT DISTINCT ON (base) base, rate
      FROM fx_rates
     WHERE quote = '${BASE_CURRENCY}'
     ORDER BY base, as_of DESC
  `)

  const table: Record<string, string> = {}
  for (const row of result.rows) table[row.base.trim()] = row.rate
  return table
}
