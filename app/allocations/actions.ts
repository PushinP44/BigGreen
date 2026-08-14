'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSessionDb } from '@/lib/db/session'
import { recordTransfer } from '@/lib/ledger/record'
import { invertRate } from '@/lib/domain/fx'
import { splitByWeight, type WeightedTarget } from '@/lib/domain/allocation'
import { BASE_CURRENCY, convert, isCurrency, money, parseRate, toDecimalString } from '@/lib/domain/money'
import { rateTableFor } from '@/lib/read/accounts'

const FALLBACK_TARGET_ID = 'fallback'

export interface AllocationActionState {
  readonly error?: string
  readonly ok?: string
}

const uuid = z.uuid()

/**
 * Accept a suggestion: create `scheduled` transfer(s) for the suggested
 * amount, from the account the inflow actually landed in (re-derived here,
 * not trusted from the form) to whichever of your accounts you picked.
 *
 * `scheduled`, not `posted` — accepting the suggestion is not the same event
 * as actually moving the money (PLAN §8).
 *
 * If you've set a target weight on any instrument, the amount splits across
 * them (your chosen interpretation of "percentage": a share of new
 * invest-money, not a rebalancing target) — one scheduled transfer per
 * weighted instrument, description naming it, still all landing in the one
 * account you picked below; go record the actual buy from there yourself
 * once you've moved it (this module's `recordTrade` handles that). Weights
 * that don't sum to 100% leave the gap in one more transfer with no
 * instrument named — the existing unweighted behaviour, never dropped.
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

    // Convert the whole suggested amount to the source account's currency
    // ONCE, then split that converted total — splitting first and converting
    // each piece separately would round at every piece instead of once, and
    // the pieces would no longer be guaranteed to sum to the converted whole.
    let totalMinor: bigint
    if (fromCurrency === BASE_CURRENCY) {
      totalMinor = suggestedHkd.amountMinor
    } else {
      // fx_rates stores <currency>/HKD; converting HKD -> <currency> needs the inverse.
      const rates = await rateTableFor(db)
      const rate = rates[fromCurrency]
      if (!rate) return { error: `no ${fromCurrency}/HKD rate available to convert the suggestion` }
      totalMinor = convert(suggestedHkd, fromCurrency, invertRate(parseRate(rate))).amountMinor
    }

    const weighted = await db.query<{ id: string; symbol: string; target_weight_bps: number }>(
      `SELECT id, symbol, target_weight_bps FROM instruments WHERE target_weight_bps > 0 ORDER BY symbol`,
    )

    const targets: WeightedTarget[] = weighted.rows.map((row) => ({
      id: row.id,
      weightBps: row.target_weight_bps,
    }))
    const totalWeightBps = targets.reduce((sum, t) => sum + t.weightBps, 0)
    // The gap between what's weighted and 100% still goes somewhere — a
    // synthetic target lets one splitByWeight call handle both cases at once
    // and keeps the "always sums to the total" guarantee in one place.
    if (totalWeightBps < 10000) {
      targets.push({ id: FALLBACK_TARGET_ID, weightBps: 10000 - totalWeightBps })
    }

    const symbolById = new Map(weighted.rows.map((row) => [row.id, row.symbol]))
    const split = splitByWeight(totalMinor, targets)

    for (const piece of split) {
      if (piece.amountMinor <= 0n) continue
      const symbol = symbolById.get(piece.id)
      await recordTransfer(db, {
        fromAccountId: suggestion.from_account_id,
        toAccountId,
        amount: toDecimalString(money(piece.amountMinor, fromCurrency)),
        description: symbol
          ? `Allocation suggestion accepted — earmarked for ${symbol}`
          : 'Allocation suggestion accepted',
        status: 'scheduled',
      })
    }

    await db.query(
      `UPDATE allocation_suggestions SET state = 'accepted', decided_at = now() WHERE id = $1`,
      [suggestionId],
    )

    revalidatePath('/')
    revalidatePath('/allocations')
    return {
      ok:
        split.length > 1
          ? `Scheduled ${split.length} transfers — confirm each once you actually move the money.`
          : 'Scheduled — confirm it once you actually move the money.',
    }
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
