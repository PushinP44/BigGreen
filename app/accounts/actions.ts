'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSessionDb } from '@/lib/db/session'
import { CURRENCIES, parseAmountInput, type Currency } from '@/lib/domain/money'
import type { ActionState } from '@/lib/action-state'

export type AccountState = ActionState

/**
 * Account kinds a person can create.
 *
 * `equity`, `expense` and `income` are deliberately absent: those represent the
 * world outside your balance sheet and are provisioned once at sign-up. Letting
 * anyone add a second "Expenses" account would give the FX policy two places to
 * book to and the system-role lookup would start guessing.
 */
const KINDS = ['cash', 'bank', 'credit_card', 'ewallet', 'brokerage'] as const

/** Front four digits of an account number, or back four of a card — whichever the account's emailed alerts show. See `resolveAccount` in lib/ingest/email.ts. */
const DIGITS4 = /^\d{4}$/

const schema = z.object({
  name: z.string().trim().min(1, 'give the account a name').max(60),
  kind: z.enum(KINDS),
  currency: z.enum(Object.keys(CURRENCIES) as [string, ...string[]]),
  isLiquid: z.boolean(),
  institution: z.string().trim().max(40).optional(),
  openingBalance: z.string().trim().optional(),
  accountDigits: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || DIGITS4.test(value), 'account digits must be exactly four numbers'),
})

export async function createAccount(
  _previous: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const parsed = schema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    currency: formData.get('currency'),
    // A credit card is a liability; it is never part of your spendable cash,
    // and the database CHECK would reject it anyway.
    isLiquid: formData.get('kind') !== 'credit_card' && formData.get('isLiquid') === 'on',
    institution: formData.get('institution') ?? undefined,
    openingBalance: formData.get('openingBalance') || undefined,
    accountDigits: formData.get('accountDigits') || undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid input' }
  }

  try {
    const { db, userId } = await requireSessionDb()

    const openingBalanceMinor = parsed.data.openingBalance
      ? parseAmountInput(parsed.data.openingBalance, parsed.data.currency as Currency).amountMinor
      : 0n

    await db.query(
      `INSERT INTO accounts
         (user_id, name, kind, currency, is_liquid, is_own, institution, opening_balance_minor, account_last4)
       VALUES ($1, $2, $3::account_kind, $4, $5, true, $6, $7, $8)`,
      [
        userId,
        parsed.data.name,
        parsed.data.kind,
        parsed.data.currency,
        parsed.data.isLiquid,
        parsed.data.institution || null,
        openingBalanceMinor.toString(),
        parsed.data.accountDigits || null,
      ],
    )

    revalidatePath('/')
    revalidatePath('/accounts')
    revalidatePath('/settings')
    return { ok: `Added ${parsed.data.name}.` }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not add that account' }
  }
}

/**
 * Archive rather than delete.
 *
 * An account with history cannot be removed without removing the transactions
 * that reference it, and deleting real financial history to tidy up a list is
 * a bad trade. Archiving hides it everywhere and leaves the ledger intact.
 */
export async function archiveAccount(
  _previous: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const id = String(formData.get('accountId') ?? '')
  if (!id) return { error: 'missing account' }

  try {
    const { db } = await requireSessionDb()
    const result = await db.query(
      `UPDATE accounts SET archived_at = now()
        WHERE id = $1 AND is_own AND archived_at IS NULL`,
      [id],
    )
    if ((result.affectedRows ?? 0) === 0) return { error: 'that account is already archived' }

    revalidatePath('/')
    revalidatePath('/accounts')
    return { ok: 'Archived.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not archive that' }
  }
}

/**
 * Set an account's institution, opening balance (what it held before you
 * started tracking it here), and the digits from its emailed alerts, for
 * accounts that already exist. `createAccount` covers all three at creation
 * time; this is the only way to correct them afterwards, since none of the
 * three is otherwise editable.
 *
 * One form covers every account (mirrors `saveCard` in
 * settings/advanced/actions.ts), each field pre-filled with its current
 * value — so an unedited row is a no-op write, and only a row the person
 * actually cleared resets to blank/zero/null. All rows commit in one
 * transaction: a bad value partway through must not leave earlier rows
 * saved and later ones not.
 */
export async function updateAccountDetails(
  _previous: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const ids = formData.getAll('accountIds').map(String)
  if (ids.length === 0) return { error: 'no accounts to save' }

  try {
    const { db } = await requireSessionDb()

    await db.transaction(async (tx) => {
      for (const id of ids) {
        const existing = await tx.query<{ currency: string }>(
          'SELECT currency FROM accounts WHERE id = $1 AND is_own AND archived_at IS NULL',
          [id],
        )
        const row = existing.rows[0]
        if (!row) throw new Error('account not found')
        const currency = row.currency.trim() as Currency

        const institutionRaw = String(formData.get(`institution.${id}`) ?? '').trim()
        if (institutionRaw.length > 40) {
          throw new Error('institution must be 40 characters or fewer')
        }

        const balanceRaw = String(formData.get(`openingBalance.${id}`) ?? '').trim()
        const openingBalanceMinor =
          balanceRaw === '' ? 0n : parseAmountInput(balanceRaw, currency).amountMinor

        const digitsRaw = String(formData.get(`accountDigits.${id}`) ?? '').trim()
        if (digitsRaw !== '' && !DIGITS4.test(digitsRaw)) {
          throw new Error('account digits must be exactly four numbers')
        }

        await tx.query(
          `UPDATE accounts SET institution = $2, opening_balance_minor = $3, account_last4 = $4 WHERE id = $1`,
          [
            id,
            institutionRaw === '' ? null : institutionRaw,
            openingBalanceMinor.toString(),
            digitsRaw === '' ? null : digitsRaw,
          ],
        )
      }
    })

    revalidatePath('/')
    revalidatePath('/accounts')
    return { ok: 'Saved.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not save those details' }
  }
}
