import 'server-only'

/**
 * First-run setup for a newly signed-in account.
 *
 * A ledger cannot record anything without its system accounts — every
 * transaction needs an outside-world counterparty to balance against — so this
 * runs at sign-in rather than lazily on first use, where a missing account
 * would surface as an incomprehensible error halfway through recording a spend.
 *
 * Idempotent: a retried sign-in, a second device, or a refreshed link all
 * arrive here and do nothing.
 */

import { getDb } from './client'
import { provisionUser } from './seed'

export async function ensureUserProvisioned(userId: string): Promise<void> {
  const db = await getDb(userId)

  await provisionUser(
    {
      async query(sql: string, params: unknown[] = []) {
        const result = await db.query<Record<string, unknown>>(sql, params)
        return { rows: result.rows }
      },
    },
    userId,
  )
}
