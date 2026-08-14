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
import { evaluateInflow } from '@/lib/domain/allocation'
import {
  BASE_CURRENCY,
  parseAmountInput,
  parseRate,
  RATE_ONE,
  rateToString,
  type Currency,
} from '@/lib/domain/money'
import { findSystemAccountId, rateTableFor } from '@/lib/read/accounts'
import { loadAllocationSettings } from '@/lib/read/settings'

export type Direction = 'spend' | 'income'

export interface RecordSimpleInput {
  readonly accountId: string
  readonly amount: string
  readonly direction: Direction
  readonly description: string
  readonly categoryId?: string | null
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

  // Every income entry through this function has the system Income account
  // (never `is_own`) as its counterparty, so it is an external inflow by
  // construction — no separate "is this external" check needed (PLAN §8).
  // Read before the transaction: settings change rarely, and this need not be
  // transactionally consistent with the write that triggers it.
  const allocationSettings =
    input.direction === 'income' ? (await loadAllocationSettings(db)).settings : null

  // One transaction for the header and all its entries. The zero-sum trigger is
  // deferred to COMMIT, so splitting these across autocommitted statements
  // would trip it on the first entry — a transaction is only ever balanced once
  // all of its legs are in.
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO transactions (id, user_id, occurred_at, status, description, source, category_id)
       VALUES ($1, $2, $3, 'posted', $4, 'manual', $5)`,
      [transactionId, userId, occurredAt, input.description || null, input.categoryId ?? null],
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

    if (allocationSettings) {
      const inflowEntry = balanced.entries.find((e) => e.accountId === input.accountId)
      const suggestion = evaluateInflow(inflowEntry?.amountHkdMinor ?? 0n, allocationSettings)

      if (suggestion) {
        // ON CONFLICT DO NOTHING makes this idempotent by construction (the
        // UNIQUE constraint on trigger_transaction_id), not by a check here —
        // re-recording is impossible for a fresh transactionId, but the same
        // discipline as the FX rate upsert either way.
        await tx.query(
          `INSERT INTO allocation_suggestions
             (user_id, trigger_transaction_id, inflow_hkd_minor, suggested_hkd_minor, rule_version, state)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           ON CONFLICT (trigger_transaction_id) DO NOTHING`,
          [
            userId,
            transactionId,
            suggestion.inflowHkdMinor.toString(),
            suggestion.suggestedHkdMinor.toString(),
            ALLOCATION_RULE_VERSION,
          ],
        )
      }
    }
  })

  return { transactionId, residualMinor: balanced.residualMinor }
}

/**
 * Bumped when the rule's thresholds/behaviour change in a way worth
 * distinguishing on old suggestions. Not read anywhere yet — recorded from
 * day one so it is available if that ever matters (PLAN §8's `rule_version`
 * column).
 */
const ALLOCATION_RULE_VERSION = '1'

export interface RecordTransferInput {
  readonly fromAccountId: string
  readonly toAccountId: string
  /** Amount leaving `from`, in `from`'s currency. */
  readonly amount: string
  /**
   * Amount arriving in `to`, in `to`'s currency. Required when the two accounts
   * differ in currency, because only you know what the bank actually credited —
   * the reference rate is not what you got.
   */
  readonly toAmount?: string
  readonly description: string
  readonly occurredAt?: Date
  /**
   * Defaults to `posted`. `scheduled` is for a transfer that hasn't actually
   * happened yet in the real world — e.g. accepting an allocation suggestion
   * (PLAN §8) creates one you still have to go execute and confirm, rather
   * than claiming money already moved when it hasn't.
   */
  readonly status?: 'posted' | 'scheduled'
}

/**
 * Move money between two accounts you own.
 *
 * Never reads as income or spending, because both legs land on `is_own`
 * accounts and every read model groups by transaction before deciding
 * (PLAN D1, `balances.transactionDeltas`).
 *
 * Cross-currency transfers book their gap to `FX Gain/Loss` rather than
 * `FX Rounding`: if you move 100 USD and 3,494 THB arrives, the difference
 * against reference rates is the bank's spread. That is real money you paid,
 * and it belongs somewhere you can see it.
 */
export async function recordTransfer(
  db: Db,
  input: RecordTransferInput,
): Promise<RecordResult> {
  if (input.fromAccountId === input.toAccountId) {
    throw new Error('cannot transfer an account to itself')
  }

  const [from, to] = await Promise.all([
    loadAccount(db, input.fromAccountId),
    loadAccount(db, input.toAccountId),
  ])

  if (!from.isOwn || !to.isOwn) {
    throw new Error('transfers move money between accounts you own; use spend or income instead')
  }

  const fromAmount = parseAmountInput(input.amount, from.currency)
  if (fromAmount.amountMinor <= 0n) throw new Error('amount must be greater than zero')

  const sameCurrency = from.currency === to.currency
  if (!sameCurrency && input.toAmount === undefined) {
    throw new Error(
      `transferring ${from.currency} to ${to.currency} needs the amount that actually ` +
        `arrived — the reference rate is not the rate your bank gave you`,
    )
  }

  const toAmount = sameCurrency
    ? fromAmount
    : parseAmountInput(input.toAmount as string, to.currency)
  if (toAmount.amountMinor <= 0n) throw new Error('received amount must be greater than zero')

  const rates = await rateTableFor(db)
  const rateFor = (currency: Currency) => {
    if (currency === BASE_CURRENCY) return RATE_ONE
    const rate = rates[currency]
    if (rate === undefined) throw new Error(`no ${currency}/${BASE_CURRENCY} rate available`)
    return parseRate(rate)
  }

  const inputs: EntryInput[] = [
    {
      accountId: input.fromAccountId,
      amountMinor: -fromAmount.amountMinor,
      currency: from.currency,
      fxRateToHkd: rateFor(from.currency),
    },
    {
      accountId: input.toAccountId,
      amountMinor: toAmount.amountMinor,
      currency: to.currency,
      fxRateToHkd: rateFor(to.currency),
    },
  ]

  const fxRoundingAccountId = await findSystemAccountId(db, 'fx_rounding')
  const balanced = balanceEntries(
    inputs,
    sameCurrency
      ? { fxRoundingAccountId }
      : {
          fxRoundingAccountId,
          fxGainLossAccountId: await findSystemAccountId(db, 'fx_gain_loss'),
        },
  )

  const transactionId = randomUUID()
  const userId = await currentUserId(db)
  const occurredAt = (input.occurredAt ?? new Date()).toISOString()

  const status = input.status ?? 'posted'

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO transactions (id, user_id, occurred_at, status, description, source)
       VALUES ($1, $2, $3, $4::transaction_status, $5, 'manual')`,
      [transactionId, userId, occurredAt, status, input.description || null],
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

interface LoadedAccount {
  readonly currency: Currency
  readonly name: string
  readonly isOwn: boolean
}

async function loadAccount(db: Db, accountId: string): Promise<LoadedAccount> {
  const result = await db.query<{ currency: string; name: string; is_own: boolean }>(
    'SELECT currency, name, is_own FROM accounts WHERE id = $1 LIMIT 1',
    [accountId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('account not found')
  return { currency: row.currency.trim() as Currency, name: row.name, isOwn: row.is_own }
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
