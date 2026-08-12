import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSafetySettings, putPoolSetting, putSetting, SETTING_KEYS } from '@/lib/read/settings'
import { DEFAULT_SETTINGS } from '@/lib/domain/safety'
import type { Db } from '@/lib/db/client'
import { createTestDb, USER_A, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db

beforeEach(async () => {
  testDb = await createTestDb()
  db = await testDb.asDb(USER_A)
})

afterEach(async () => {
  await testDb.close()
})

describe('defaults', () => {
  it('falls back to the built-in settings on an empty database', async () => {
    const { settings } = await loadSafetySettings(db)
    expect(settings.discretionaryBudgetHkdMinor).toBe(
      DEFAULT_SETTINGS.discretionaryBudgetHkdMinor,
    )
    expect(settings.pools.HKD?.floorDays).toBe(45)
    expect(settings.horizonDays).toBe(30)
  })

  it('flags which values are still placeholders', async () => {
    // The owner said they would set the discretionary budget themselves; the
    // settings page has to be able to say "this is still my guess, not yours".
    const { form } = await loadSafetySettings(db)
    expect(form.usingDefaults[SETTING_KEYS.discretionaryBudget]).toBe(true)

    await putSetting(db, SETTING_KEYS.discretionaryBudget, '450000')
    const after = await loadSafetySettings(db)
    expect(after.form.usingDefaults[SETTING_KEYS.discretionaryBudget]).toBe(false)
  })
})

describe('round-trip', () => {
  it('stores and reads a blended budget', async () => {
    await putSetting(db, SETTING_KEYS.discretionaryBudget, '450000')
    const { settings } = await loadSafetySettings(db)
    expect(settings.discretionaryBudgetHkdMinor).toBe(450_000n)
  })

  it('stores per-pool floors and spends independently', async () => {
    await putPoolSetting(db, SETTING_KEYS.floorDays, 'HKD', 60)
    await putPoolSetting(db, SETTING_KEYS.declaredMonthlySpend, 'HKD', '750000')
    await putPoolSetting(db, SETTING_KEYS.floorDays, 'THB', 14)
    await putPoolSetting(db, SETTING_KEYS.declaredMonthlySpend, 'THB', '2000000')

    const { settings } = await loadSafetySettings(db)
    expect(settings.pools.HKD).toEqual({ floorDays: 60, declaredMonthlySpendMinor: 750_000n })
    expect(settings.pools.THB).toEqual({ floorDays: 14, declaredMonthlySpendMinor: 2_000_000n })
    // USD untouched, so it keeps its default of no floor.
    expect(settings.pools.USD?.floorDays).toBe(0)
  })

  it('keeps amounts as bigint, never as a float', async () => {
    await putPoolSetting(db, SETTING_KEYS.declaredMonthlySpend, 'HKD', '9007199254740993')
    const { settings } = await loadSafetySettings(db)
    // Past 2^53 — a JSON number would have silently rounded this.
    expect(settings.pools.HKD?.declaredMonthlySpendMinor).toBe(9_007_199_254_740_993n)
  })
})

describe('versioning', () => {
  it('reads the latest value at or before the given time', async () => {
    await db.query(
      `INSERT INTO rule_settings (user_id, key, value_json, effective_from)
       VALUES ($1, $2, '"100000"', '2026-01-01T00:00:00Z'),
              ($1, $2, '"200000"', '2026-06-01T00:00:00Z')`,
      [USER_A, SETTING_KEYS.discretionaryBudget],
    )

    // A verdict recorded in March must still reflect March's rule.
    const march = await loadSafetySettings(db, new Date('2026-03-01T00:00:00Z'))
    expect(march.settings.discretionaryBudgetHkdMinor).toBe(100_000n)

    const august = await loadSafetySettings(db, new Date('2026-08-01T00:00:00Z'))
    expect(august.settings.discretionaryBudgetHkdMinor).toBe(200_000n)
  })

  it('ignores a value that is not yet effective', async () => {
    await db.query(
      `INSERT INTO rule_settings (user_id, key, value_json, effective_from)
       VALUES ($1, $2, '"999999"', '2027-01-01T00:00:00Z')`,
      [USER_A, SETTING_KEYS.discretionaryBudget],
    )
    const { settings } = await loadSafetySettings(db, new Date('2026-08-01T00:00:00Z'))
    expect(settings.discretionaryBudgetHkdMinor).toBe(
      DEFAULT_SETTINGS.discretionaryBudgetHkdMinor,
    )
  })
})

describe('bad data', () => {
  it('falls back rather than taking the safety rule down', async () => {
    // A malformed row must not break the dashboard — but it must not pass
    // silently either, so it reads as "still using the default".
    await db.query(
      `INSERT INTO rule_settings (user_id, key, value_json) VALUES ($1, $2, 'not json')`,
      [USER_A, SETTING_KEYS.discretionaryBudget],
    )

    const { settings, form } = await loadSafetySettings(db)
    expect(settings.discretionaryBudgetHkdMinor).toBe(
      DEFAULT_SETTINGS.discretionaryBudgetHkdMinor,
    )
    expect(form.usingDefaults[SETTING_KEYS.discretionaryBudget]).toBe(true)
  })

  it('rejects a negative or non-integer day count by falling back', async () => {
    await putSetting(db, SETTING_KEYS.horizonDays, -5)
    const { settings } = await loadSafetySettings(db)
    expect(settings.horizonDays).toBe(DEFAULT_SETTINGS.horizonDays)
  })

  it('is scoped by RLS like everything else', async () => {
    await putSetting(db, SETTING_KEYS.discretionaryBudget, '450000')

    const other = await testDb.asDb('22222222-2222-4222-8222-222222222222')
    const { settings } = await loadSafetySettings(other)
    expect(settings.discretionaryBudgetHkdMinor).toBe(
      DEFAULT_SETTINGS.discretionaryBudgetHkdMinor,
    )
  })
})
