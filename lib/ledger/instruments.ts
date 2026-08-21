import 'server-only'

/**
 * Writing instrument positions to the ledger — new instruments, buys, sells,
 * and legacy additions (PLAN §4.3/§4.4). Same orchestration-only shape as
 * `record.ts`: parsing, balancing and the residual policy are delegated to
 * pure functions; this module only does I/O.
 *
 * A buy/sell's two legs both sit on the same brokerage account — one leg is
 * the plain cash movement (no instrument tag), the other carries
 * `instrumentId`/`quantityDelta` at the same magnitude, opposite sign. They
 * sum to zero the way any double-entry pair does, and the account's own net
 * balance is unchanged by a buy: cash converts to a position, no new money
 * entered. `holdings.ts`'s `computeHoldings` is what breaks the position back
 * out from the account's blended cash-and-stock total.
 *
 * A sell's instrument leg carries the *proceeds*, not the cost — deliberately.
 * `computeHoldings` already excludes any negative-quantity leg from the
 * cost-basis sum regardless of its `amountMinor`, so what a sell's amount
 * says here does not affect the remaining position's average cost. Using
 * proceeds keeps the pair balanced without needing a separate realised-gain
 * account, which nothing in PLAN §3 specifies.
 */

import { randomUUID } from 'node:crypto'
import type { Db } from '@/lib/db/client'
import { balanceEntries, type EntryInput } from '@/lib/domain/fx'
import { parseQuantity, quantityToString } from '@/lib/domain/holdings'
import {
  BASE_CURRENCY,
  isCurrency,
  parseAmountInput,
  parseRate,
  RATE_ONE,
  rateToString,
  type Currency,
  type Rate,
} from '@/lib/domain/money'
import { findSystemAccountId, rateTableFor } from '@/lib/read/accounts'

export interface RecordResult {
  readonly transactionId: string
}

export interface CreateInstrumentInput {
  readonly symbol: string
  readonly kind: 'stock' | 'etf' | 'index_fund' | 'mutual_fund'
  readonly currency: Currency
  readonly exchange?: string | null
}

export async function createInstrument(
  db: Db,
  input: CreateInstrumentInput,
): Promise<{ id: string }> {
  const symbol = input.symbol.trim().toUpperCase()
  if (!symbol) throw new Error('symbol is required')

  const userId = await currentUserId(db)
  const result = await db.query<{ id: string }>(
    `INSERT INTO instruments (user_id, symbol, kind, currency, exchange)
     VALUES ($1, $2, $3::instrument_kind, $4, $5)
     ON CONFLICT (user_id, symbol) DO NOTHING
     RETURNING id`,
    [userId, symbol, input.kind, input.currency, input.exchange?.trim() || null],
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error(`${symbol} already exists`)
  return { id }
}

/** Null clears the weight — "not part of the split", distinct from 0 ("explicitly excluded"). */
export async function setInstrumentWeight(
  db: Db,
  instrumentId: string,
  weightBps: number | null,
): Promise<void> {
  if (weightBps !== null && (!Number.isInteger(weightBps) || weightBps < 0 || weightBps > 10000)) {
    throw new Error('weight must be a whole percentage between 0 and 100')
  }
  await db.query('UPDATE instruments SET target_weight_bps = $2 WHERE id = $1', [
    instrumentId,
    weightBps,
  ])
}

export interface RecordTradeInput {
  readonly instrumentId: string
  readonly accountId: string
  readonly side: 'buy' | 'sell'
  readonly quantity: string
  /** Total cash moved: cost for a buy, proceeds for a sell — not a per-share price. */
  readonly amount: string
  readonly description: string
  readonly occurredAt?: Date
}

export async function recordTrade(db: Db, input: RecordTradeInput): Promise<RecordResult> {
  const instrument = await loadInstrument(db, input.instrumentId)
  const quantity = parseQuantity(input.quantity)
  if (quantity.scaled <= 0n) throw new Error('quantity must be greater than zero')

  const amount = parseAmountInput(input.amount, instrument.currency)
  if (amount.amountMinor <= 0n) throw new Error('amount must be greater than zero')

  const cashSign = input.side === 'buy' ? -1n : 1n
  const signedQuantity = input.side === 'buy' ? quantity.scaled : -quantity.scaled

  const rate = await rateFor(db, instrument.currency)
  const fxRoundingAccountId = await findSystemAccountId(db, 'fx_rounding')

  const inputs: EntryInput[] = [
    {
      accountId: input.accountId,
      amountMinor: cashSign * amount.amountMinor,
      currency: instrument.currency,
      fxRateToHkd: rate,
    },
    {
      accountId: input.accountId,
      amountMinor: -cashSign * amount.amountMinor,
      currency: instrument.currency,
      fxRateToHkd: rate,
      instrumentId: input.instrumentId,
      quantityDelta: quantityToString({ scaled: signedQuantity }),
    },
  ]

  const balanced = balanceEntries(inputs, { fxRoundingAccountId })
  return writeTransaction(db, balanced.entries, input.description, input.occurredAt)
}

export interface RecordLegacyPositionInput {
  readonly instrumentId: string
  readonly accountId: string
  readonly quantity: string
  /** Undefined/null means unknown — `COST UNKNOWN`, never zero, is the point (PLAN §3). */
  readonly costMinor?: bigint | null
  readonly description: string
  readonly occurredAt?: Date
}

/**
 * A position with no transaction history — quantity as of today, cost
 * optional. Balances against `Opening Equity`, the same system account every
 * ledger already has (PLAN §4.4).
 */
export async function recordLegacyPosition(
  db: Db,
  input: RecordLegacyPositionInput,
): Promise<RecordResult> {
  const instrument = await loadInstrument(db, input.instrumentId)
  const quantity = parseQuantity(input.quantity)
  if (quantity.scaled <= 0n) throw new Error('quantity must be greater than zero')

  const costMinor = input.costMinor ?? 0n
  if (costMinor < 0n) throw new Error('cost cannot be negative')

  const rate = await rateFor(db, instrument.currency)
  const openingEquityId = await findSystemAccountId(db, 'opening_equity')
  const fxRoundingAccountId = await findSystemAccountId(db, 'fx_rounding')

  const inputs: EntryInput[] = [
    {
      accountId: input.accountId,
      amountMinor: costMinor,
      currency: instrument.currency,
      fxRateToHkd: rate,
      instrumentId: input.instrumentId,
      quantityDelta: quantityToString(quantity),
    },
    {
      accountId: openingEquityId,
      amountMinor: -costMinor,
      currency: instrument.currency,
      fxRateToHkd: rate,
    },
  ]

  const balanced = balanceEntries(inputs, { fxRoundingAccountId })
  return writeTransaction(db, balanced.entries, input.description, input.occurredAt)
}

async function writeTransaction(
  db: Db,
  entries: readonly {
    accountId: string
    amountMinor: bigint
    currency: Currency
    fxRateToHkd: Rate
    amountHkdMinor: bigint
    isFxResidual: boolean
    instrumentId?: string | null | undefined
    quantityDelta?: string | null | undefined
  }[],
  description: string,
  occurredAt?: Date,
): Promise<RecordResult> {
  const transactionId = randomUUID()
  const userId = await currentUserId(db)
  const when = (occurredAt ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO transactions (id, user_id, occurred_at, status, description, source)
       VALUES ($1, $2, $3, 'posted', $4, 'manual')`,
      [transactionId, userId, when, description || null],
    )

    for (const entry of entries) {
      await tx.query(
        `INSERT INTO entries
           (user_id, transaction_id, account_id, amount_minor, currency,
            fx_rate_to_hkd, amount_hkd_minor, is_fx_residual, instrument_id, quantity_delta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          userId,
          transactionId,
          entry.accountId,
          entry.amountMinor.toString(),
          entry.currency,
          rateToString(entry.fxRateToHkd),
          entry.amountHkdMinor.toString(),
          entry.isFxResidual,
          entry.instrumentId ?? null,
          entry.quantityDelta ?? null,
        ],
      )
    }
  })

  return { transactionId }
}

/**
 * Voids a mis-entered buy/sell/legacy position — same convention as
 * `/review`'s discard: never a delete, never an in-place edit of a posted
 * entry's amount, which risks leaving that transaction's legs out of
 * balance. Scoped to transactions that actually carry an instrument leg, so
 * this cannot be pointed at an unrelated spend or transfer.
 *
 * Returns false when there was nothing to void — already voided, or not a
 * position at all — so the caller can say so rather than reporting success.
 */
export async function voidPosition(db: Db, transactionId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE transactions
        SET status = 'void', booked_at = now()
      WHERE id = $1 AND status = 'posted'
        AND id IN (SELECT transaction_id FROM entries WHERE instrument_id IS NOT NULL)`,
    [transactionId],
  )
  return (result.affectedRows ?? 0) > 0
}

async function loadInstrument(
  db: Db,
  instrumentId: string,
): Promise<{ currency: Currency; symbol: string }> {
  const result = await db.query<{ currency: string; symbol: string }>(
    'SELECT currency, symbol FROM instruments WHERE id = $1 LIMIT 1',
    [instrumentId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('instrument not found')
  const currency = row.currency.trim()
  if (!isCurrency(currency)) throw new Error(`instrument ${row.symbol} has unsupported currency`)
  return { currency, symbol: row.symbol }
}

async function rateFor(db: Db, currency: Currency): Promise<Rate> {
  if (currency === BASE_CURRENCY) return RATE_ONE
  const rates = await rateTableFor(db)
  const rate = rates[currency]
  if (rate === undefined) throw new Error(`no ${currency}/${BASE_CURRENCY} rate available`)
  return parseRate(rate)
}

async function currentUserId(db: Db): Promise<string> {
  const result = await db.query<{ uid: string | null }>('SELECT auth.uid() AS uid')
  const uid = result.rows[0]?.uid
  if (!uid) throw new Error('no authenticated user in session')
  return uid
}
