import 'server-only'

/**
 * Rule settings.
 *
 * PLAN §3: thresholds are DATA, not constants — changing a floor is a row, not
 * a deploy. Rev 4 makes that matter in practice: rev 1 through 3 shipped
 * hardcoded guesses (a HK$10,000 cushion, a HK$6,000 budget) that the owner had
 * no way to correct. Everything the safety rule reads now comes from here.
 *
 * Rows are versioned by `effective_from`, so changing a threshold does not
 * rewrite the history of decisions already made under the old one. Reads take
 * the latest row at or before `now`.
 */

import { z } from 'zod'
import type { Db } from '@/lib/db/client'
import { DEFAULT_SETTINGS, type PoolSettings, type SafetySettings } from '@/lib/domain/safety'
import { isCurrency, type Currency } from '@/lib/domain/money'

export const SETTING_KEYS = {
  floorDays: 'safety.floor_days',
  declaredMonthlySpend: 'safety.declared_monthly_spend',
  discretionaryBudget: 'safety.discretionary_budget',
  horizonDays: 'safety.horizon_days',
  burnWindowDays: 'safety.burn_window_days',
  minHistoryDays: 'safety.min_history_days',
} as const

/** Per-currency values are stored as one row keyed `<key>.<currency>`. */
function poolKey(key: string, currency: Currency): string {
  return `${key}.${currency}`
}

const nonNegativeInt = z.number().int().min(0).max(3650)
const minorAmount = z.string().regex(/^\d+$/)

export interface SettingsForm {
  readonly floorDays: Readonly<Partial<Record<Currency, number>>>
  readonly declaredMonthlySpendMinor: Readonly<Partial<Record<Currency, string>>>
  readonly discretionaryBudgetHkdMinor: string
  readonly horizonDays: number
  readonly burnWindowDays: number
  readonly minHistoryDays: number
  /** True while a value is still the built-in placeholder rather than the owner's. */
  readonly usingDefaults: Readonly<Record<string, boolean>>
}

export async function loadSafetySettings(
  db: Db,
  now: Date = new Date(),
): Promise<{ settings: SafetySettings; form: SettingsForm }> {
  const result = await db.query<{ key: string; value_json: string }>(
    `SELECT DISTINCT ON (key) key, value_json
       FROM rule_settings
      WHERE effective_from <= $1
      ORDER BY key, effective_from DESC`,
    [now.toISOString()],
  )

  const stored = new Map(result.rows.map((row) => [row.key, row.value_json]))
  const usingDefaults: Record<string, boolean> = {}

  const read = <T>(key: string, fallback: T, parse: (raw: unknown) => T): T => {
    const raw = stored.get(key)
    usingDefaults[key] = raw === undefined
    if (raw === undefined) return fallback
    try {
      return parse(JSON.parse(raw))
    } catch {
      // A malformed row must not take the safety rule down with it, but it also
      // must not pass silently — the flag surfaces on the settings page.
      usingDefaults[key] = true
      return fallback
    }
  }

  const currencies: Currency[] = ['HKD', 'USD', 'THB']
  const pools: Partial<Record<Currency, PoolSettings>> = {}
  const floorDays: Partial<Record<Currency, number>> = {}
  const declared: Partial<Record<Currency, string>> = {}

  for (const currency of currencies) {
    const fallback = DEFAULT_SETTINGS.pools[currency] ?? {
      floorDays: 0,
      declaredMonthlySpendMinor: 0n,
    }

    const days = read(poolKey(SETTING_KEYS.floorDays, currency), fallback.floorDays, (raw) =>
      nonNegativeInt.parse(raw),
    )
    const spend = read(
      poolKey(SETTING_KEYS.declaredMonthlySpend, currency),
      fallback.declaredMonthlySpendMinor,
      (raw) => BigInt(minorAmount.parse(raw)),
    )

    pools[currency] = { floorDays: days, declaredMonthlySpendMinor: spend }
    floorDays[currency] = days
    declared[currency] = spend.toString()
  }

  const discretionary = read(
    SETTING_KEYS.discretionaryBudget,
    DEFAULT_SETTINGS.discretionaryBudgetHkdMinor,
    (raw) => BigInt(minorAmount.parse(raw)),
  )
  const horizonDays = read(SETTING_KEYS.horizonDays, DEFAULT_SETTINGS.horizonDays, (raw) =>
    nonNegativeInt.parse(raw),
  )
  const burnWindowDays = read(
    SETTING_KEYS.burnWindowDays,
    DEFAULT_SETTINGS.burnWindowDays,
    (raw) => z.number().int().min(1).max(3650).parse(raw),
  )
  const minHistoryDays = read(SETTING_KEYS.minHistoryDays, DEFAULT_SETTINGS.minHistoryDays, (raw) =>
    nonNegativeInt.parse(raw),
  )

  return {
    settings: {
      pools,
      discretionaryBudgetHkdMinor: discretionary,
      horizonDays,
      burnWindowDays,
      minHistoryDays,
    },
    form: {
      floorDays,
      declaredMonthlySpendMinor: declared,
      discretionaryBudgetHkdMinor: discretionary.toString(),
      horizonDays,
      burnWindowDays,
      minHistoryDays,
      usingDefaults,
    },
  }
}

/**
 * Write a setting as a new version rather than an update.
 *
 * `effective_from` is stamped now, so a verdict recorded last month still
 * reflects the rule that was in force when it was made.
 */
export async function putSetting(db: Db, key: string, value: unknown): Promise<void> {
  const userId = await currentUserId(db)
  await db.query(
    `INSERT INTO rule_settings (user_id, key, value_json, effective_from)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, key, effective_from)
     DO UPDATE SET value_json = EXCLUDED.value_json`,
    [userId, key, JSON.stringify(value)],
  )
}

export async function putPoolSetting(
  db: Db,
  key: string,
  currency: Currency,
  value: unknown,
): Promise<void> {
  if (!isCurrency(currency)) throw new Error(`unknown currency ${currency}`)
  await putSetting(db, poolKey(key, currency), value)
}

async function currentUserId(db: Db): Promise<string> {
  const result = await db.query<{ uid: string | null }>('SELECT auth.uid() AS uid')
  const uid = result.rows[0]?.uid
  if (!uid) throw new Error('no authenticated user in session')
  return uid
}
