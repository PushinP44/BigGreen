'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSessionDb } from '@/lib/db/session'
import { recordTransfer } from '@/lib/ledger/record'
import { invertRate } from '@/lib/domain/fx'
import { BASE_CURRENCY, convert, isCurrency, money, parseRate, toDecimalString } from '@/lib/domain/money'
import { rateTableFor } from '@/lib/read/accounts'

export interface AllocationActionState {
  readonly error?: string
  readonly ok?: string
}

const uuid = z.uuid()

/**
 * Accept a suggestion: create a `scheduled` transfer for the suggested
 * amount, from the account the inflow actually landed in (re-derived here,
 * not trusted from the form) to whichever of your accounts you picked.
 *
 * `scheduled`, not `posted` — accepting the suggestion is not the same event
 * as actually moving the money (PLAN §8).
 */
export async function acceptSuggestion(
  _previous: AllocationActionState,
  formData: FormData,
): Promise<AllocationActionState> {
  const suggestionId = formData.get('suggestionId')
  const toAccountId = formData.get('toAccountId')

  if (typeof suggestionId !== 'string' || !uuid.safeParse(suggestionId).success) {
    return { error: 'invalid suggestion' }
  }
  if (typeof toAccountId !== 'string' || !uuid.safeParse(toAccountId).success) {
    return { error: 'pick a destination account' }
  }

  try {
    const { db } = await requireSessionDb()

    const result = await db.query<{
      suggested_hkd_minor: string
      state: string
      from_account_id: string | null
      from_currency: string | null
    }>(
      `WITH principal AS (
         SELECT DISTINCT ON (e.transaction_id)
           e.transaction_id, a.id AS account_id, a.currency
         FROM entries e
         JOIN accounts a ON a.id = e.account_id
        WHERE a.is_own
        ORDER BY e.transaction_id, abs(e.amount_hkd_minor) DESC, a.name
       )
       SELECT s.suggested_hkd_minor, s.state::text AS state,
              principal.account_id AS from_account_id, principal.currency AS from_currency
         FROM allocation_suggestions s
         LEFT JOIN principal ON principal.transaction_id = s.trigger_transaction_id
        WHERE s.id = $1`,
      [suggestionId],
    )
    const suggestion = result.rows[0]
    if (!suggestion) return { error: 'suggestion not found' }
    if (suggestion.state !== 'pending') return { error: `already ${suggestion.state}` }
    if (!suggestion.from_account_id || !suggestion.from_currency) {
      return { error: 'could not find the account the inflow landed in' }
    }

    const fromCurrency = suggestion.from_currency.trim()
    if (!isCurrency(fromCurrency)) return { error: `unsupported currency ${fromCurrency}` }

    const suggestedHkd = money(BigInt(suggestion.suggested_hkd_minor), 'HKD')
    let amount: string

    if (fromCurrency === BASE_CURRENCY) {
      amount = toDecimalString(suggestedHkd)
    } else {
      // fx_rates stores <currency>/HKD; converting HKD -> <currency> needs the inverse.
      const rates = await rateTableFor(db)
      const rate = rates[fromCurrency]
      if (!rate) return { error: `no ${fromCurrency}/HKD rate available to convert the suggestion` }
      amount = toDecimalString(convert(suggestedHkd, fromCurrency, invertRate(parseRate(rate))))
    }

    await recordTransfer(db, {
      fromAccountId: suggestion.from_account_id,
      toAccountId,
      amount,
      description: 'Allocation suggestion accepted',
      status: 'scheduled',
    })

    await db.query(
      `UPDATE allocation_suggestions SET state = 'accepted', decided_at = now() WHERE id = $1`,
      [suggestionId],
    )

    revalidatePath('/')
    revalidatePath('/allocations')
    return { ok: 'Scheduled — confirm it once you actually move the money.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not accept suggestion' }
  }
}

const dismissSchema = z.object({
  suggestionId: uuid,
  reason: z.string().trim().min(1, 'say why — a suggestion you never act on is worse than none, and the reason is how you find that out'),
})

/** Dismissing without a reason isn't allowed — PLAN §8 tracks the accept rate, and an unexplained "no" makes it meaningless. */
export async function dismissSuggestion(
  _previous: AllocationActionState,
  formData: FormData,
): Promise<AllocationActionState> {
  const parsed = dismissSchema.safeParse({
    suggestionId: formData.get('suggestionId'),
    reason: formData.get('reason'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid input' }

  try {
    const { db } = await requireSessionDb()
    await db.query(
      `UPDATE allocation_suggestions
          SET state = 'dismissed', decided_at = now(), dismiss_reason = $2
        WHERE id = $1 AND state = 'pending'`,
      [parsed.data.suggestionId, parsed.data.reason],
    )
    revalidatePath('/')
    revalidatePath('/allocations')
    return { ok: 'Dismissed.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not dismiss suggestion' }
  }
}
