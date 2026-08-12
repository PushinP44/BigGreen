'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getDb } from '@/lib/db/client'
import { parseAmountInput, type Currency } from '@/lib/domain/money'
import { putPoolSetting, putSetting, SETTING_KEYS } from '@/lib/read/settings'

export interface SettingsState {
  readonly error?: string
  readonly ok?: string
}

const CURRENCIES: Currency[] = ['HKD', 'USD', 'THB']

const schema = z.object({
  discretionaryBudget: z.string().min(1, 'enter a discretionary budget'),
  horizonDays: z.coerce.number().int().min(0).max(365),
  burnWindowDays: z.coerce.number().int().min(1).max(3650),
  minHistoryDays: z.coerce.number().int().min(0).max(3650),
})

/**
 * Save the rule settings.
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
    horizonDays: formData.get('horizonDays'),
    burnWindowDays: formData.get('burnWindowDays'),
    minHistoryDays: formData.get('minHistoryDays'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid input' }
  }

  try {
    const db = await getDb()

    const budget = parseAmountInput(parsed.data.discretionaryBudget, 'HKD')
    if (budget.amountMinor < 0n) return { error: 'discretionary budget cannot be negative' }
    await putSetting(db, SETTING_KEYS.discretionaryBudget, budget.amountMinor.toString())

    await putSetting(db, SETTING_KEYS.horizonDays, parsed.data.horizonDays)
    await putSetting(db, SETTING_KEYS.burnWindowDays, parsed.data.burnWindowDays)
    await putSetting(db, SETTING_KEYS.minHistoryDays, parsed.data.minHistoryDays)

    for (const currency of CURRENCIES) {
      const days = Number(formData.get(`floorDays.${currency}`) ?? 0)
      if (!Number.isInteger(days) || days < 0 || days > 3650) {
        return { error: `${currency} floor days must be a whole number of days` }
      }
      await putPoolSetting(db, SETTING_KEYS.floorDays, currency, days)

      const spendRaw = String(formData.get(`monthlySpend.${currency}`) ?? '').trim()
      const spend = spendRaw === '' ? 0n : parseAmountInput(spendRaw, currency).amountMinor
      if (spend < 0n) return { error: `${currency} monthly spend cannot be negative` }
      await putPoolSetting(db, SETTING_KEYS.declaredMonthlySpend, currency, spend.toString())
    }

    revalidatePath('/')
    revalidatePath('/settings')
    return { ok: 'Saved. The safety rule uses these from now on.' }
  } catch (error) {
    // Surfaced verbatim: every message these paths throw is written for the
    // person who just typed the number (PLAN §12).
    return { error: error instanceof Error ? error.message : 'could not save' }
  }
}
