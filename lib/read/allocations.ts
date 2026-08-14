import 'server-only'

/**
 * Allocation suggestions read model. Query only — accept/dismiss logic lives
 * in `app/allocations/actions.ts`, the same split as every other read model.
 */

import type { Db } from '@/lib/db/client'

export interface PendingSuggestion {
  readonly id: string
  readonly inflowHkdMinor: string
  readonly suggestedHkdMinor: string
  readonly createdAt: string
  readonly triggerDescription: string | null
  readonly fromAccountName: string | null
}

/**
 * Pending suggestions with the triggering transaction's principal (largest
 * owned-account) leg — the same "which account does the user think of as
 * this transaction" pattern `lib/read/ledger.ts`'s `listRecentTransactions`
 * already uses, here just for display; the accept action re-derives this
 * itself rather than trusting anything the client sends back.
 */
export async function listPendingSuggestions(db: Db): Promise<PendingSuggestion[]> {
  const result = await db.query<{
    id: string
    inflow_hkd_minor: string
    suggested_hkd_minor: string
    created_at: string
    description: string | null
    account_name: string | null
  }>(`
    WITH principal AS (
      SELECT DISTINCT ON (e.transaction_id)
        e.transaction_id, a.name AS account_name
      FROM entries e
      JOIN accounts a ON a.id = e.account_id
      WHERE a.is_own
      ORDER BY e.transaction_id, abs(e.amount_hkd_minor) DESC, a.name
    )
    SELECT
      s.id, s.inflow_hkd_minor, s.suggested_hkd_minor, s.created_at::text AS created_at,
      t.description, principal.account_name
    FROM allocation_suggestions s
    JOIN transactions t ON t.id = s.trigger_transaction_id
    LEFT JOIN principal ON principal.transaction_id = s.trigger_transaction_id
    WHERE s.state = 'pending'
    ORDER BY s.created_at DESC
  `)

  return result.rows.map((row) => ({
    id: row.id,
    inflowHkdMinor: row.inflow_hkd_minor,
    suggestedHkdMinor: row.suggested_hkd_minor,
    createdAt: row.created_at,
    triggerDescription: row.description,
    fromAccountName: row.account_name,
  }))
}

export async function countPendingSuggestions(db: Db): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM allocation_suggestions WHERE state = 'pending'`,
  )
  return result.rows[0]?.n ?? 0
}
