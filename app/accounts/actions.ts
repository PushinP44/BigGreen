'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSessionDb } from '@/lib/db/session'
import { CURRENCIES } from '@/lib/domain/money'

export interface AccountState {
  readonly error?: string
  readonly ok?: string
}

/**
 * Account kinds a person can create.
 *
 * `equity`, `expense` and `income` are deliberately absent: those represent the
 * world outside your balance sheet and are provisioned once at sign-up. Letting
 * anyone add a second "Expenses" account would give the FX policy two places to
 * book to and the system-role lookup would start guessing.
 */
const KINDS = ['cash', 'bank', 'credit_card', 'ewallet', 'brokerage'] as const

const schema = z.object({
  name: z.string().trim().min(1, 'give the account a name').max(60),
  kind: z.enum(KINDS),
  currency: z.enum(Object.keys(CURRENCIES) as [string, ...string[]]),
  isLiquid: z.boolean(),
  institution: z.string().trim().max(40).optional(),
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
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid input' }
  }

  try {
    const { db, userId } = await requireSessionDb()

    await db.query(
      `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, institution)
       VALUES ($1, $2, $3::account_kind, $4, $5, true, $6)`,
      [
        userId,
        parsed.data.name,
        parsed.data.kind,
        parsed.data.currency,
        parsed.data.isLiquid,
        parsed.data.institution || null,
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
