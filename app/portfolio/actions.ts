'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSessionDb } from '@/lib/db/session'
import {
  createInstrument,
  recordLegacyPosition,
  recordTrade,
  setInstrumentWeight,
} from '@/lib/ledger/instruments'
import { parseAmountInput, type Currency } from '@/lib/domain/money'

export interface PortfolioActionState {
  readonly error?: string
  readonly ok?: string
}

const instrumentSchema = z.object({
  symbol: z.string().trim().min(1, 'enter a symbol'),
  kind: z.enum(['stock', 'etf', 'index_fund', 'mutual_fund']),
  currency: z.enum(['HKD', 'USD', 'THB']),
  exchange: z.string().trim().optional(),
})

export async function addInstrument(
  _previous: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  const parsed = instrumentSchema.safeParse({
    symbol: formData.get('symbol'),
    kind: formData.get('kind'),
    currency: formData.get('currency'),
    exchange: formData.get('exchange') || undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid input' }

  try {
    const { db } = await requireSessionDb()
    await createInstrument(db, parsed.data)
    revalidatePath('/portfolio')
    return { ok: `${parsed.data.symbol.toUpperCase()} added.` }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not add instrument' }
  }
}

const weightSchema = z.object({
  instrumentId: z.uuid(),
  weightPercent: z.string(),
})

/** Blank clears the weight (not part of the split); 0 explicitly excludes it. */
export async function saveWeight(
  _previous: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  const parsed = weightSchema.safeParse({
    instrumentId: formData.get('instrumentId'),
    weightPercent: formData.get('weightPercent'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid input' }

  const trimmed = parsed.data.weightPercent.trim()
  const weightBps = trimmed === '' ? null : Math.round(Number(trimmed) * 100)
  if (weightBps !== null && !Number.isFinite(weightBps)) {
    return { error: 'weight must be a number' }
  }

  try {
    const { db } = await requireSessionDb()
    await setInstrumentWeight(db, parsed.data.instrumentId, weightBps)
    revalidatePath('/portfolio')
    return { ok: 'Saved.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not save weight' }
  }
}

const tradeSchema = z.object({
  instrumentId: z.uuid('pick an instrument'),
  accountId: z.uuid('pick an account'),
  side: z.enum(['buy', 'sell']),
  quantity: z.string().min(1, 'enter a quantity'),
  amount: z.string().min(1, 'enter an amount'),
  description: z.string().max(200).optional(),
})

export async function recordTradeAction(
  _previous: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  const parsed = tradeSchema.safeParse({
    instrumentId: formData.get('instrumentId'),
    accountId: formData.get('accountId'),
    side: formData.get('side'),
    quantity: formData.get('quantity'),
    amount: formData.get('amount'),
    description: formData.get('description') ?? undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid input' }

  try {
    const { db } = await requireSessionDb()
    await recordTrade(db, {
      instrumentId: parsed.data.instrumentId,
      accountId: parsed.data.accountId,
      side: parsed.data.side,
      quantity: parsed.data.quantity,
      amount: parsed.data.amount,
      description: parsed.data.description ?? '',
    })
    revalidatePath('/')
    revalidatePath('/portfolio')
    return { ok: parsed.data.side === 'buy' ? 'Buy recorded.' : 'Sale recorded.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not record trade' }
  }
}

const legacySchema = z.object({
  instrumentId: z.uuid('pick an instrument'),
  accountId: z.uuid('pick an account'),
  quantity: z.string().min(1, 'enter a quantity'),
  costMinor: z.string().optional(),
  currency: z.enum(['HKD', 'USD', 'THB']),
  description: z.string().max(200).optional(),
})

export async function recordLegacyPositionAction(
  _previous: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  const parsed = legacySchema.safeParse({
    instrumentId: formData.get('instrumentId'),
    accountId: formData.get('accountId'),
    quantity: formData.get('quantity'),
    costMinor: formData.get('cost') || undefined,
    currency: formData.get('currency'),
    description: formData.get('description') ?? undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'invalid input' }

  try {
    const { db } = await requireSessionDb()
    const costRaw = parsed.data.costMinor?.trim()
    const costMinor =
      costRaw === undefined || costRaw === ''
        ? null
        : parseAmountInput(costRaw, parsed.data.currency as Currency).amountMinor

    await recordLegacyPosition(db, {
      instrumentId: parsed.data.instrumentId,
      accountId: parsed.data.accountId,
      quantity: parsed.data.quantity,
      costMinor,
      description: parsed.data.description ?? '',
    })
    revalidatePath('/')
    revalidatePath('/portfolio')
    return { ok: 'Legacy position added.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not add position' }
  }
}
