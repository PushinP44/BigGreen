'use server'

import { revalidatePath } from 'next/cache'
import { requireSessionDb } from '@/lib/db/session'

export interface ReviewState {
  readonly error?: string
  readonly ok?: string
}

/**
 * Confirm or discard a pending transaction.
 *
 * Discarding voids rather than deletes: a parsed email that turned out to be
 * wrong is still something that happened, and the `external_id` has to survive
 * so the Apps Script does not re-ingest the same message on its next pass.
 * Deleting the row would make the idempotency guard forget it.
 */
export async function resolvePending(
  _previous: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const id = String(formData.get('transactionId') ?? '')
  const action = String(formData.get('action') ?? '')

  if (!id) return { error: 'missing transaction' }
  if (action !== 'confirm' && action !== 'discard') return { error: 'unknown action' }

  try {
    const { db } = await requireSessionDb()
    const status = action === 'confirm' ? 'posted' : 'void'

    const result = await db.query(
      `UPDATE transactions
          SET status = $2::transaction_status, booked_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [id, status],
    )

    if ((result.affectedRows ?? 0) === 0) {
      return { error: 'that transaction is no longer pending' }
    }

    revalidatePath('/')
    revalidatePath('/review')
    return { ok: action === 'confirm' ? 'Posted.' : 'Discarded.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not update that' }
  }
}
