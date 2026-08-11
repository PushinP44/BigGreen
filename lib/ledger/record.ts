import 'server-only'

/**
 * Writing to the ledger.
 *
 * This is orchestration — it does I/O, so it is not `lib/domain/`. Every
 * decision it makes (parsing the amount, converting, balancing, the residual
 * policy) is delegated to a pure function that has already been tested without
 * a database.
 */

import { randomUUID } from 'node:crypto'
import type { Db } from '@/lib/db/client'
import { balanceEntries, type EntryInput } from '@/lib/domain/fx'
import {
  BASE_CURRENCY,
  parseAmountInput,
  parseRate,
  RATE_ONE,
  rateToString,
  type Currency,
} from '@/lib/domain/money'
import { findSystemAccountId, rateTableFor } from '@/lib/read/accounts'

export type Direction = 'spend' | 'income'

export interface RecordSimpleInput {
  readonly accountId: string
  readonly amount: string
  readonly direction: Direction
  readonly description: string
  readonly occurredAt?: Date
}

export interface RecordResult {
  readonly transactionId: string
  readonly residualMinor: bigint
}

/**
 * Record a single-currency spend or income against one of your accounts.
 *
 * The counterparty is the system `expense` or `income` account, which is what
 * makes this a real double-entry transaction rather than a signed list — and is
 * what will later let the allocation rule tell new money from your own money
 * moving between your accounts (PLAN §8).
 */
export async function recordSimpleTransaction(
  db: Db,
  input: RecordSimpleInput,
): Promise<RecordResult> {
  const account = await db.query<{ currency: string; name: string }>(
    'SELECT currency, name FROM accounts WHERE id = $1 LIMIT 1',
    [input.accountId],
  )
  const row = account.rows[0]
  if (!row) throw new Error('account not found')

  const currency = row.currency.trim() as Currency
  const amount = parseAmountInput(input.amount, currency)
  if (amount.amountMinor <= 0n) {
    throw new Error('amount must be greater than zero')
  }

  const rate =
    currency === BASE_CURRENCY
      ? RATE_ONE
      : parseRate(
          (await rateTableFor(db))[currency] ??
            (() => {
              throw new Error(`no ${currency}/${BASE_CURRENCY} rate available`)
            })(),
        )

  const counterpartyId = await findSystemAccountId(
    db,
    input.direction === 'spend' ? 'expense' : 'income',
  )
  const fxRoundingAccountId = await findSystemAccountId(db, 'fx_rounding')

  // Spend: money leaves the account (negative) and lands in expenses.
  // Income: the reverse.
  const sign = input.direction === 'spend' ? -1n : 1n

  const inputs: EntryInput[] = [
    {
      accountId: input.accountId,
      amountMinor: sign * amount.amountMinor,
      currency,
      fxRateToHkd: rate,
    },
    {
      accountId: counterpartyId,
      amountMinor: -sign * amount.amountMinor,
      currency,
      fxRateToHkd: rate,
    },
  ]

  const balanced = balanceEntries(inputs, { fxRoundingAccountId })

  const transactionId = randomUUID()
  const occurredAt = (input.occurredAt ?? new Date()).toISOString()

  const userId = await currentUserId(db)

  // One transaction for the header and all its entries. The zero-sum trigger is
  // deferred to COMMIT, so splitting these across autocommitted statements
  // would trip it on the first entry — a transaction is only ever balanced once
  // all of its legs are in.
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO transactions (id, user_id, occurred_at, status, description, source)
       VALUES ($1, $2, $3, 'posted', $4, 'manual')`,
      [transactionId, userId, occurredAt, input.description || null],
    )

    for (const entry of balanced.entries) {
      await tx.query(
        `INSERT INTO entries
           (user_id, transaction_id, account_id, amount_minor, currency,
            fx_rate_to_hkd, amount_hkd_minor, is_fx_residual)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          transactionId,
          entry.accountId,
          entry.amountMinor.toString(),
          entry.currency,
          rateToString(entry.fxRateToHkd),
          entry.amountHkdMinor.toString(),
          entry.isFxResidual,
        ],
      )
    }
  })

  return { transactionId, residualMinor: balanced.residualMinor }
}

/**
 * The id RLS is currently scoping to. Reading it back from the session rather
 * than passing it in means a caller cannot write rows for someone else even by
 * mistake — the value always matches the policy that will judge the write.
 */
async function currentUserId(db: Db): Promise<string> {
  const result = await db.query<{ uid: string | null }>('SELECT auth.uid() AS uid')
  const uid = result.rows[0]?.uid
  if (!uid) throw new Error('no authenticated user in session')
  return uid
}
