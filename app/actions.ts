'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSessionDb } from '@/lib/db/session'
import { recordSimpleTransaction, recordTransfer, type Direction } from '@/lib/ledger/record'
import { syncRates } from '@/lib/fx/frankfurter'
import { syncPrices } from '@/lib/fx/finnhub'
import type { ActionState as BaseActionState } from '@/lib/action-state'

/**
 * The one action state that carries more than the shared `error`/`ok` pair —
 * everything else in the app aliases `ActionState` from `@/lib/action-state`
 * directly.
 */
export interface ActionState extends BaseActionState {
  /**
   * Set only on a successful spend/income (never on a transfer, which is
   * never external money in or out — PLAN D1). Sourced from what the server
   * actually recorded rather than the form's own `kind` state, so switching
   * the segmented control after submitting but before the response lands
   * can't fire the wrong money-in/money-out effect (smart_alert).
   */
  readonly direction?: Direction
}

const optionalUuid = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value))
  .refine((value) => value === null || z.uuid().safeParse(value).success, 'invalid category')

const simpleSchema = z.object({
  accountId: z.uuid('pick an account'),
  amount: z.string().min(1, 'enter an amount'),
  direction: z.enum(['spend', 'income']),
  description: z.string().max(200).optional(),
  categoryId: optionalUuid,
})

const transferSchema = z.object({
  fromAccountId: z.uuid('pick an account to transfer from'),
  toAccountId: z.uuid('pick an account to transfer to'),
  amount: z.string().min(1, 'enter an amount'),
  toAmount: z.string().optional(),
  description: z.string().max(200).optional(),
})

/**
 * Errors are surfaced verbatim rather than replaced with "something went
 * wrong". Every message these paths throw is written for the person who just
 * typed the amount, and a swallowed one here is a wrong balance (PLAN §12).
 */
function toState(error: unknown): ActionState {
  return { error: error instanceof Error ? error.message : 'could not record that' }
}

export async function addTransaction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const kind = formData.get('kind')

  if (kind === 'transfer') {
    const parsed = transferSchema.safeParse({
      fromAccountId: formData.get('fromAccountId'),
      toAccountId: formData.get('toAccountId'),
      amount: formData.get('amount'),
      toAmount: formData.get('toAmount') ?? undefined,
      description: formData.get('description') ?? undefined,
    })
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid input' }

    try {
      const { db } = await requireSessionDb()
      const toAmount = parsed.data.toAmount?.trim()
      const result = await recordTransfer(db, {
        fromAccountId: parsed.data.fromAccountId,
        toAccountId: parsed.data.toAccountId,
        amount: parsed.data.amount,
        ...(toAmount ? { toAmount } : {}),
        description: parsed.data.description ?? '',
      })
      revalidatePath('/')
      return {
        ok:
          result.residualMinor === 0n
            ? 'Transfer recorded.'
            : `Transfer recorded. FX difference of ${result.residualMinor} minor units booked.`,
      }
    } catch (error) {
      return toState(error)
    }
  }

  const parsed = simpleSchema.safeParse({
    accountId: formData.get('accountId'),
    amount: formData.get('amount'),
    direction: kind === 'income' ? 'income' : 'spend',
    description: formData.get('description') ?? undefined,
    categoryId: formData.get('categoryId') ?? undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid input' }

  try {
    const { db } = await requireSessionDb()
    const result = await recordSimpleTransaction(db, {
      accountId: parsed.data.accountId,
      amount: parsed.data.amount,
      direction: parsed.data.direction,
      description: parsed.data.description ?? '',
      categoryId: parsed.data.categoryId,
    })
    revalidatePath('/')
    return {
      ok:
        result.residualMinor === 0n
          ? 'Recorded.'
          : `Recorded, with ${result.residualMinor} minor units of FX rounding.`,
      direction: parsed.data.direction,
    }
  } catch (error) {
    return toState(error)
  }
}

export async function refreshRates(_previous: ActionState): Promise<ActionState> {
  try {
    const { db } = await requireSessionDb()
    const result = await syncRates(db)
    revalidatePath('/')

    if (result.rejected.length > 0) {
      return {
        error: `Rejected ${result.rejected.map((r) => r.currency).join(', ')}: ${result.rejected[0]?.reason}`,
      }
    }
    return {
      ok:
        result.written === 0
          ? `Already up to date (${result.asOf ?? 'no date'}).`
          : `Updated ${result.written} rate(s) as of ${result.asOf}.`,
    }
  } catch (error) {
    return toState(error)
  }
}

export async function refreshPrices(_previous: ActionState): Promise<ActionState> {
  try {
    const { db } = await requireSessionDb()
    const result = await syncPrices(db, new Date())
    revalidatePath('/')

    if (result.failed.length > 0 && result.written === 0 && result.unchanged === 0) {
      return { error: `Could not price any position: ${result.failed[0]?.reason}` }
    }
    const skipped = result.failed.length > 0 ? `, ${result.failed.length} skipped` : ''
    return {
      ok:
        result.written === 0
          ? `Already up to date (${result.asOf}${skipped}).`
          : `Updated ${result.written} price(s) as of ${result.asOf}${skipped}.`,
    }
  } catch (error) {
    return toState(error)
  }
}
