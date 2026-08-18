/**
 * ZA Bank — PLAN §7.0 recorded this as "push-first, no per-transaction
 * email" based on earlier research. That turned out to be wrong: ZA sends
 * per-transaction alerts for card spend, outgoing transfers, and brokerage
 * trades alike (see PLAN §13's note on this correction).
 *
 * Pure: no I/O, no clock.
 */

import { priceToAmountMinor } from '@/lib/domain/holdings'
import { isCurrency } from '@/lib/domain/money'
import { findLabeledAmount, findLabeledValue, offsetDateTime } from './shared'
import type { EmailMessage, ParsedTransfer, ParsedTrade, ParseResult, Parser } from './types'

const SENDER = /za\.group|zabank|za\.com\.hk/i

function isFrom(message: EmailMessage): boolean {
  return SENDER.test(message.from)
}

// ── Card transaction ─────────────────────────────────────────────────────

const CARD_SIGNAL = /you have spent with your za card/i
const CARD_LAST4 = /ZA Card\s*\(\s*(\d{4})\s*\)/i
const CARD_AMOUNT_LABEL = /\bAmount:?/i
const CARD_MERCHANT_LABEL = /\bMerchant:?/i
const CARD_MERCHANT_VALUE = /^\s*([A-Z0-9][^\n]{1,58})/
const CARD_TIMESTAMP = /on\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/i

function parseCardTransaction(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!CARD_SIGNAL.test(text)) return null

  const amount = findLabeledAmount(text, CARD_AMOUNT_LABEL)
  if (!amount) return null

  const notes: string[] = []

  const last4 = CARD_LAST4.exec(text)?.[1] ?? null
  if (!last4) notes.push('no card number found')

  const merchant = findLabeledValue(text, CARD_MERCHANT_LABEL, CARD_MERCHANT_VALUE)
  if (!merchant) notes.push('no merchant found')

  const ts = CARD_TIMESTAMP.exec(text)

  let confidence = 0.85
  if (last4) confidence += 0.08
  if (merchant) confidence += 0.07

  return {
    parserId: 'za-card-transaction',
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    fields: {
      kind: 'transaction',
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      // "You have spent" is unambiguous — this template has no credit variant.
      direction: 'spend',
      merchant,
      accountLast4: last4,
      occurredAt: ts
        ? offsetDateTime(
            Number(ts[1]),
            Number(ts[2]),
            Number(ts[3]),
            Number(ts[4]),
            Number(ts[5]),
            Number(ts[6]),
            8,
          )
        : null,
      description: merchant ?? 'ZA card transaction',
    },
    notes,
  }
}

// ── Outgoing transfer ─────────────────────────────────────────────────────
//
// Never names the payee beyond a masked phone number, so `counterpartyLabel`
// carries that forward but will not resolve to one of your own accounts
// unless it happens to mention an institution by name.

const TRANSFER_SIGNAL = /outgoing amount/i
const TRANSFER_AMOUNT_LABEL = /Outgoing Amount/i
const TRANSFER_PAYEE_LABEL = /\bPayee:?/i
const TRANSFER_PAYEE_VALUE = /^\s*([+0-9*][+0-9*-]{3,19})/
const TRANSFER_TIMESTAMP = /at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/i

function parseTransfer(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!TRANSFER_SIGNAL.test(text)) return null

  const amount = findLabeledAmount(text, TRANSFER_AMOUNT_LABEL)
  if (!amount) return null

  const counterpartyLabel = findLabeledValue(text, TRANSFER_PAYEE_LABEL, TRANSFER_PAYEE_VALUE)
  const ts = TRANSFER_TIMESTAMP.exec(text)

  const fields: ParsedTransfer = {
    kind: 'transfer',
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    accountLast4: null,
    accountRole: 'source',
    counterpartyLabel,
    occurredAt: ts
      ? offsetDateTime(
          Number(ts[1]),
          Number(ts[2]),
          Number(ts[3]),
          Number(ts[4]),
          Number(ts[5]),
          Number(ts[6]),
          8,
        )
      : null,
    description: 'ZA Bank transfer',
  }

  return {
    parserId: 'za-transfer',
    confidence: 0.85,
    fields,
    notes: counterpartyLabel ? [] : ['no payee identifier found'],
  }
}

// ── Brokerage trade ──────────────────────────────────────────────────────
//
// Only a per-unit price is given, never a total, so the cash amount has to
// be computed — `priceToAmountMinor` does that as exact integer arithmetic,
// never a float (lib/domain/holdings.ts).

const TRADE_SIGNAL = /order instruction of stock is fully executed/i
const TRADE_SIDE = /your\s+(buy|sell)\s+order instruction/i
// The colon is load-bearing: the subject line reads "Buy order of GRAB
// (Grab Holdings)" with no colon, and without one this label would match
// there first and capture "of" as the symbol instead of the real one two
// lines into the body.
const SYMBOL_LABEL = /\b(?:Buy|Sell) order:/i
const SYMBOL_VALUE = /^\s*([A-Z][A-Z0-9.]{0,9})/
const QUANTITY_LABEL = /Order quantity:?/i
const QUANTITY_VALUE = /^\s*([\d,]+(?:\.\d+)?)/
const PRICE_PATTERN = /(HKD|USD|THB)\s*\n?\s*([\d,]+(?:\.\d+)?)/i

function parseTrade(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!TRADE_SIGNAL.test(text)) return null

  const sideMatch = TRADE_SIDE.exec(text)
  const side = sideMatch?.[1]?.toLowerCase() === 'sell' ? 'sell' : 'buy'

  const symbol = findLabeledValue(text, SYMBOL_LABEL, SYMBOL_VALUE)
  const quantityRaw = findLabeledValue(text, QUANTITY_LABEL, QUANTITY_VALUE)
  const priceMatch = PRICE_PATTERN.exec(text)

  if (!symbol || !quantityRaw || !priceMatch) return null

  const quantity = quantityRaw.replace(/,/g, '')
  const currency = priceMatch[1]!.toUpperCase()
  const pricePerUnit = priceMatch[2]!.replace(/,/g, '')

  if (!isCurrency(currency)) return null

  let amountMinor: bigint
  try {
    amountMinor = priceToAmountMinor(quantity, pricePerUnit, currency)
  } catch {
    // A quantity or price we cannot represent exactly is not one to record.
    return null
  }
  if (amountMinor <= 0n) return null

  const fields: ParsedTrade = {
    kind: 'trade',
    side,
    symbol,
    isin: null,
    // ZA's own confirmations are always in "shares" — nothing in this
    // template distinguishes an ETF from a single stock, and neither
    // matters for how the trade posts, only for how it displays.
    instrumentKind: 'stock',
    quantity,
    amountMinor,
    currency,
    accountLast4: null,
    occurredAt: null,
    description: `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`,
  }

  return {
    parserId: 'za-trade',
    confidence: 0.85,
    fields,
    notes: [],
  }
}

export const zaParser: Parser = {
  id: 'za',

  matches(message: EmailMessage): boolean {
    return isFrom(message)
  },

  parse(message: EmailMessage): ParseResult | null {
    return parseCardTransaction(message) ?? parseTransfer(message) ?? parseTrade(message)
  },
}
