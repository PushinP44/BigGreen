'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSessionDb } from '@/lib/db/session'
import { parseAmountInput } from '@/lib/domain/money'
import { putSetting, SETTING_KEYS } from '@/lib/read/settings'

export interface SettingsState {
  readonly error?: string
  readonly ok?: string
}

const schema = z.object({
  discretionaryBudget: z.string().min(1, 'enter a discretionary budget'),
})

/**
 * Save the discretionary budget and credit model — the two settings common
 * enough to live on the main page. Floors per pool, timing, ingest confidence
 * and credit card billing terms are on /settings/advanced.
 *
 * Amounts go through `parseAmountInput`, the same function the entry form uses,
 * so "6,000" and "6000.00" behave identically here and there — and so a value
 * that would silently lose precision is rejected rather than stored.
 */
export async function saveSettings(
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const parsed = schema.safeParse({
    discretionaryBudget: formData.get('discretionaryBudget'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid input' }
  }

  try {
    const { db } = await requireSessionDb()

    const budget = parseAmountInput(parsed.data.discretionaryBudget, 'HKD')
    if (budget.amountMinor < 0n) return { error: 'discretionary budget cannot be negative' }
    await putSetting(db, SETTING_KEYS.discretionaryBudget, budget.amountMinor.toString())

    await putSetting(
      db,
      SETTING_KEYS.creditModel,
      formData.get('creditModel') === 'full_balance' ? 'full_balance' : 'minimum_payment',
    )

    revalidatePath('/')
    revalidatePath('/settings')
    return { ok: 'Saved. The safety rule uses these from now on.' }
  } catch (error) {
    // Surfaced verbatim: every message these paths throw is written for the
    // person who just typed the number (PLAN §12).
    return { error: error instanceof Error ? error.message : 'could not save' }
  }
}
