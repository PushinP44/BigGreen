'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSessionDb } from '@/lib/db/session'
import { parseAmountInput, type Currency } from '@/lib/domain/money'
import { putPoolSetting, putSetting, SETTING_KEYS } from '@/lib/read/settings'

export interface SettingsState {
  readonly error?: string
  readonly ok?: string
}

const CURRENCIES: Currency[] = ['HKD', 'USD', 'THB']

const schema = z.object({
  horizonDays: z.coerce.number().int().min(0).max(365),
  burnWindowDays: z.coerce.number().int().min(1).max(3650),
  minHistoryDays: z.coerce.number().int().min(0).max(3650),
  autoPostConfidence: z.coerce.number().min(0).max(1),
})

/**
 * Save the floors-per-pool, timing, and ingest tuning that most sessions never
 * touch. Split from `saveSettings` so the common case (budget, credit model)
 * isn't buried under fields nobody changes week to week.
 */
export async function saveAdvancedSettings(
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const parsed = schema.safeParse({
    horizonDays: formData.get('horizonDays'),
    burnWindowDays: formData.get('burnWindowDays'),
    minHistoryDays: formData.get('minHistoryDays'),
    autoPostConfidence: formData.get('autoPostConfidence'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid input' }
  }

  try {
    const { db } = await requireSessionDb()

    await putSetting(db, SETTING_KEYS.horizonDays, parsed.data.horizonDays)
    await putSetting(db, SETTING_KEYS.burnWindowDays, parsed.data.burnWindowDays)
    await putSetting(db, SETTING_KEYS.minHistoryDays, parsed.data.minHistoryDays)
    await putSetting(db, SETTING_KEYS.autoPostConfidence, parsed.data.autoPostConfidence)

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
    revalidatePath('/settings/advanced')
    return { ok: 'Saved. The safety rule uses these from now on.' }
  } catch (error) {
    // Surfaced verbatim: every message these paths throw is written for the
    // person who just typed the number (PLAN §12).
    return { error: error instanceof Error ? error.message : 'could not save' }
  }
}

/**
 * Save credit-card billing terms.
 *
 * Blank means "not recorded" rather than zero: a card with no statement day
 * falls back to the conservative whole-balance model, and storing 0 would let
 * the cycle maths run on a day that does not exist.
 */
export async function saveCard(
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  try {
    const { db } = await requireSessionDb()
    const ids = formData.getAll('cardIds').map(String)

    for (const id of ids) {
      const day = (name: string): number | null => {
        const raw = String(formData.get(`${name}.${id}`) ?? '').trim()
        if (raw === '') return null
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 1 || value > 31) {
          throw new Error(`${name} must be a day of the month between 1 and 31`)
        }
        return value
      }

      const amount = (name: string, currency: Currency): bigint | null => {
        const raw = String(formData.get(`${name}.${id}`) ?? '').trim()
        if (raw === '') return null
        const value = parseAmountInput(raw, currency).amountMinor
        if (value < 0n) throw new Error(`${name} cannot be negative`)
        return value
      }

      const percentBps = (name: string): number | null => {
        const raw = String(formData.get(`${name}.${id}`) ?? '').trim()
        if (raw === '') return null
        const value = Number(raw)
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          throw new Error(`${name} must be a percentage between 0 and 100`)
        }
        return Math.round(value * 100)
      }

      const account = await db.query<{ currency: string }>(
        'SELECT currency FROM accounts WHERE id = $1 AND kind = $2 LIMIT 1',
        [id, 'credit_card'],
      )
      const row = account.rows[0]
      if (!row) throw new Error('credit card account not found')
      const currency = row.currency.trim() as Currency

      const statementDay = day('statementDay')
      const paymentDueDay = day('paymentDueDay')
      // Half a cycle is worse than none: the model needs both boundaries or it
      // cannot tell billed from un-billed.
      if ((statementDay === null) !== (paymentDueDay === null)) {
        throw new Error('set both the statement day and the payment due day, or neither')
      }

      const last4Raw = String(formData.get(`last4.${id}`) ?? '').trim()
      if (last4Raw !== '' && !/^\d{4}$/.test(last4Raw)) {
        throw new Error('card ending must be exactly four digits')
      }

      await db.query(
        `UPDATE accounts SET
           account_last4 = $8,
           statement_day = $2,
           payment_due_day = $3,
           credit_limit_minor = $4,
           apr_bps = $5,
           min_payment_pct_bps = $6,
           min_payment_floor_minor = $7
         WHERE id = $1`,
        [
          id,
          statementDay,
          paymentDueDay,
          amount('creditLimit', currency)?.toString() ?? null,
          percentBps('apr'),
          percentBps('minPct'),
          amount('minFloor', currency)?.toString() ?? null,
          last4Raw === '' ? null : last4Raw,
        ],
      )
    }

    revalidatePath('/')
    revalidatePath('/settings/advanced')
    return { ok: 'Card terms saved. The safety rule now uses your real billing cycle.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not save card terms' }
  }
}
