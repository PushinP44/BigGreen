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
/**
 * The accounts every ledger needs, regardless of whose it is.
 *
 * These are the outside-world counterparties (expense/income) and the two the
 * FX policy books to. Without them a transaction has nothing to balance
 * against, so they are created for every user at sign-up.
 *
 * Note what is NOT here: real bank accounts. Those are personal, and seeding a
 * new user with someone else's HSBC and Octopus accounts would be both wrong
 * and faintly alarming.
 */
export const SYSTEM_ACCOUNT_SEED: ReadonlyArray<{
  name: string
  kind: string
  systemRole: string
}> = [
  { name: 'Expenses', kind: 'expense', systemRole: 'expense' },
  { name: 'Income', kind: 'income', systemRole: 'income' },
  { name: 'Opening Equity', kind: 'equity', systemRole: 'opening_equity' },
  { name: 'FX Rounding', kind: 'equity', systemRole: 'fx_rounding' },
  { name: 'FX Gain/Loss', kind: 'expense', systemRole: 'fx_gain_loss' },
]

/**
 * The owner's own accounts.
 *
 * Used by the local development database and by `pnpm db:seed`, never by
 * sign-up. Kept here so local and the owner's real database stay identical.
 */
export const OWNER_ACCOUNT_SEED: ReadonlyArray<{
  name: string
  kind: string
  currency: string
  isLiquid: boolean
  institution: string | null
}> = [
  { name: 'HSBC HKD', kind: 'bank', currency: 'HKD', isLiquid: true, institution: 'hsbc' },
  { name: 'ZA Bank', kind: 'bank', currency: 'HKD', isLiquid: true, institution: 'za' },
  { name: 'Mox', kind: 'bank', currency: 'HKD', isLiquid: true, institution: 'mox' },
  { name: 'Octopus', kind: 'ewallet', currency: 'HKD', isLiquid: true, institution: 'octopus' },
  { name: 'PayMe', kind: 'ewallet', currency: 'HKD', isLiquid: true, institution: 'payme' },
  { name: 'HSBC Credit Card', kind: 'credit_card', currency: 'HKD', isLiquid: false, institution: 'hsbc' },
  { name: 'ZA Bank USD', kind: 'bank', currency: 'USD', isLiquid: true, institution: 'za' },
  { name: 'Krung Thai (KTB)', kind: 'bank', currency: 'THB', isLiquid: true, institution: 'ktb' },
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

/**
 * Everything a brand-new account needs to be usable: the system accounts and a
 * starter category list. Idempotent, so a retried sign-up is harmless.
 */
export async function provisionUser(db: SeedQuery, userId: string): Promise<SeedResult> {
  const existing = await db.query(
    "SELECT 1 AS present FROM accounts WHERE user_id = $1 AND system_role = 'expense' LIMIT 1",
    [userId],
  )
  if (existing.rows.length > 0) return { accountsCreated: 0, categoriesCreated: 0 }

  for (const account of SYSTEM_ACCOUNT_SEED) {
    await db.query(
      `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, system_role)
       VALUES ($1, $2, $3::account_kind, 'HKD', false, false, $4)`,
      [userId, account.name, account.kind, account.systemRole],
    )
  }

  for (const category of CATEGORY_SEED) {
    await db.query(
      'INSERT INTO categories (user_id, name, is_discretionary) VALUES ($1, $2, $3)',
      [userId, category.name, category.isDiscretionary],
    )
  }

  return {
    accountsCreated: SYSTEM_ACCOUNT_SEED.length,
    categoriesCreated: CATEGORY_SEED.length,
  }
}

/**
 * The owner's own setup: system accounts plus their real banks. Used by local
 * development and `pnpm db:seed`, never by sign-up.
 */
export async function seedInitialData(db: SeedQuery, userId: string): Promise<SeedResult> {
  const provisioned = await provisionUser(db, userId)

  const owned = await db.query(
    'SELECT 1 AS present FROM accounts WHERE user_id = $1 AND is_own LIMIT 1',
    [userId],
  )
  if (owned.rows.length > 0) return provisioned

  for (const account of OWNER_ACCOUNT_SEED) {
    await db.query(
      `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, institution)
       VALUES ($1, $2, $3::account_kind, $4, $5, true, $6)`,
      [userId, account.name, account.kind, account.currency, account.isLiquid, account.institution],
    )
  }

  return {
    accountsCreated: provisioned.accountsCreated + OWNER_ACCOUNT_SEED.length,
    categoriesCreated: provisioned.categoriesCreated,
  }
}
