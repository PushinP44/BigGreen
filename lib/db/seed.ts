/**
 * Initial data — accounts and categories.
 *
 * Driver-agnostic on purpose: the same seed runs against the local PGlite
 * database and against Supabase, so what you develop on and what you keep your
 * real money in are shaped identically. Idempotent, so re-running is a no-op.
 *
 * Deliberately no placeholder FX rates. The dev database seeded a couple so the
 * multi-currency path had something to work with before the Frankfurter job
 * existed; putting invented rates into the database that holds your actual
 * balances would be a different thing entirely.
 */

export interface SeedQuery {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * The single user's identity.
 *
 * Real Supabase Auth is not wired up yet — this is a single-user app with
 * public signup disabled (PLAN §11), so one fixed uuid stands in. It does not
 * need a row in `auth.users`: the RLS policies only compare `user_id` against
 * `auth.uid()`, and `auth.uid()` reads the JWT claim the app sets. Swapping to
 * real auth later means changing where this value comes from, not the policies.
 *
 * Lives here rather than in `client.ts` so scripts can import it without
 * pulling in `server-only`.
 */
export const APP_USER_ID = '00000000-0000-4000-8000-000000000001'

/**
 * Three pools (PLAN rev 4): HKD across the HK banks and wallets, USD at ZA,
 * THB at Krung Thai. Foreign currency lives only in ZA and KTB.
 *
 * The three non-own accounts (expense/income/equity) are what give every
 * transaction a counterparty leg without a nullable `account_id`, and are the
 * test the allocation rule uses to tell new money from your own money moving
 * around (PLAN §8).
 */
export const ACCOUNT_SEED: ReadonlyArray<{
  name: string
  kind: string
  currency: string
  isLiquid: boolean
  isOwn: boolean
  institution: string | null
  systemRole: string | null
}> = [
  { name: 'HSBC HKD', kind: 'bank', currency: 'HKD', isLiquid: true, isOwn: true, institution: 'hsbc', systemRole: null },
  { name: 'ZA Bank', kind: 'bank', currency: 'HKD', isLiquid: true, isOwn: true, institution: 'za', systemRole: null },
  { name: 'Mox', kind: 'bank', currency: 'HKD', isLiquid: true, isOwn: true, institution: 'mox', systemRole: null },
  { name: 'Octopus', kind: 'ewallet', currency: 'HKD', isLiquid: true, isOwn: true, institution: 'octopus', systemRole: null },
  { name: 'PayMe', kind: 'ewallet', currency: 'HKD', isLiquid: true, isOwn: true, institution: 'payme', systemRole: null },
  { name: 'HSBC Credit Card', kind: 'credit_card', currency: 'HKD', isLiquid: false, isOwn: true, institution: 'hsbc', systemRole: null },
  { name: 'ZA Bank USD', kind: 'bank', currency: 'USD', isLiquid: true, isOwn: true, institution: 'za', systemRole: null },
  { name: 'Krung Thai (KTB)', kind: 'bank', currency: 'THB', isLiquid: true, isOwn: true, institution: 'ktb', systemRole: null },
  { name: 'Expenses', kind: 'expense', currency: 'HKD', isLiquid: false, isOwn: false, institution: null, systemRole: 'expense' },
  { name: 'Income', kind: 'income', currency: 'HKD', isLiquid: false, isOwn: false, institution: null, systemRole: 'income' },
  { name: 'Opening Equity', kind: 'equity', currency: 'HKD', isLiquid: false, isOwn: false, institution: null, systemRole: 'opening_equity' },
  { name: 'FX Rounding', kind: 'equity', currency: 'HKD', isLiquid: false, isOwn: false, institution: null, systemRole: 'fx_rounding' },
  { name: 'FX Gain/Loss', kind: 'expense', currency: 'HKD', isLiquid: false, isOwn: false, institution: null, systemRole: 'fx_gain_loss' },
]

/**
 * `is_discretionary` drives the CAUTION band of the safety rule (PLAN §5), so
 * the split matters: it is "could I have skipped this?", not "was it nice?".
 * Rent and utilities are not discretionary however much you dislike paying them.
 */
export const CATEGORY_SEED: ReadonlyArray<{ name: string; isDiscretionary: boolean }> = [
  { name: 'Food & Drink', isDiscretionary: true },
  { name: 'Groceries', isDiscretionary: false },
  { name: 'Transport', isDiscretionary: false },
  { name: 'Rent', isDiscretionary: false },
  { name: 'Utilities', isDiscretionary: false },
  { name: 'Health', isDiscretionary: false },
  { name: 'Shopping', isDiscretionary: true },
  { name: 'Entertainment', isDiscretionary: true },
  { name: 'Travel', isDiscretionary: true },
  { name: 'Fees & Charges', isDiscretionary: false },
  { name: 'Other', isDiscretionary: false },
]

export interface SeedResult {
  readonly accountsCreated: number
  readonly categoriesCreated: number
}

export async function seedInitialData(db: SeedQuery, userId: string): Promise<SeedResult> {
  const existing = await db.query('SELECT count(*)::int AS n FROM accounts WHERE user_id = $1', [
    userId,
  ])
  if (Number(existing.rows[0]?.n ?? 0) > 0) {
    return { accountsCreated: 0, categoriesCreated: 0 }
  }

  for (const account of ACCOUNT_SEED) {
    await db.query(
      `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, institution, system_role)
       VALUES ($1, $2, $3::account_kind, $4, $5, $6, $7, $8)`,
      [
        userId,
        account.name,
        account.kind,
        account.currency,
        account.isLiquid,
        account.isOwn,
        account.institution,
        account.systemRole,
      ],
    )
  }

  for (const category of CATEGORY_SEED) {
    await db.query(
      'INSERT INTO categories (user_id, name, is_discretionary) VALUES ($1, $2, $3)',
      [userId, category.name, category.isDiscretionary],
    )
  }

  return { accountsCreated: ACCOUNT_SEED.length, categoriesCreated: CATEGORY_SEED.length }
}
