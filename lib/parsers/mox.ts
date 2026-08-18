/**
 * Mox Bank — PLAN §7.0 recorded this as "push-first, no per-transaction
 * email" based on earlier research. That turned out to be wrong for trades
 * and transfers alike (see PLAN §13's note on this correction); no card
 * product sample has turned up yet, so there is no Mox card parser here.
 *
 * Mox's alerts read as a dense sentence rather than a label/value table —
 * unlike HSBC and ZA, so the extraction below matches against the sentence
 * shape directly instead of hunting for "Label: value" pairs.
 *
 * Pure: no I/O, no clock.
 */

import { isCurrency, parseAmountInput } from '@/lib/domain/money'
import { monthIndex, offsetDateTime } from './shared'
import type { EmailMessage, ParsedTransfer, ParsedTrade, ParseResult, Parser } from './types'

const SENDER = /mox\.com|moxbank/i

function isFrom(message: EmailMessage): boolean {
  return SENDER.test(message.from)
}

// ── Brokerage trade ──────────────────────────────────────────────────────
//
// "400.0000 units of HK0000947546 Allianz Yield Plus successfully sold at
// HKD11.2554, total HKD4,502.16." — unlike ZA, Mox states the total
// directly, so there is no need for `priceToAmountMinor`'s derived math here.

const TRADE_MATCH =
  /([\d,]+(?:\.\d+)?)\s+units?\s+of\s+([A-Z]{2}[A-Z0-9]{9}\d)\s+(.+?)\s+successfully\s+(sold|bought|purchased)/i
const TOTAL_MATCH = /total\s+(HKD|USD|THB)\s*([\d,]+(?:\.\d+)?)/i

function parseTrade(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  const tradeMatch = TRADE_MATCH.exec(text)
  if (!tradeMatch) return null

  const totalMatch = TOTAL_MATCH.exec(text)
  if (!totalMatch) return null

  const currency = totalMatch[1]!.toUpperCase()
  if (!isCurrency(currency)) return null

  const quantity = tradeMatch[1]!.replace(/,/g, '')
  const isin = tradeMatch[2]!
  const name = tradeMatch[3]!.trim()
  const side = tradeMatch[4]!.toLowerCase() === 'sold' ? 'sell' : 'buy'

  let amountMinor: bigint
  try {
    amountMinor = parseAmountInput(totalMatch[2]!, currency).amountMinor
  } catch {
    return null
  }
  if (amountMinor <= 0n) return null

  const fields: ParsedTrade = {
    kind: 'trade',
    side,
    // The fund's own name, not the ISIN — a portfolio dropdown showing
    // "HK0000947546" would be unreadable. The ISIN is what actually
    // de-duplicates against a position added through this same parser
    // again later, or through the manual "+" flow if that form is ever
    // extended to collect one.
    symbol: name,
    isin,
    // Mox's own wording is "units", never "shares" — the signal this
    // codebase has for calling it a fund rather than a stock. Revisit if a
    // Mox ETF confirmation ever turns up using the same phrasing.
    instrumentKind: 'mutual_fund',
    quantity,
    amountMinor,
    currency,
    accountLast4: null,
    occurredAt: null,
    description: `${side === 'buy' ? 'Buy' : 'Sell'} ${name}`,
  }

  return {
    parserId: 'mox-trade',
    confidence: 0.9,
    fields,
    notes: [],
  }
}

// ── Outgoing transfer ─────────────────────────────────────────────────────

const TRANSFER_SIGNAL = /you transferred/i
const TRANSFER_AMOUNT = /transferred\s+(HKD|USD|THB)\s*([\d,]+(?:\.\d{1,2})?)/i
const TRANSFER_PAYEE = /\bto\s+(.+?)\s+on\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}/i
const TRANSFER_TIMESTAMP = /on\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\s+(\d{2}):(\d{2})HKT/i

function parseTransfer(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!TRANSFER_SIGNAL.test(text)) return null

  const amountMatch = TRANSFER_AMOUNT.exec(text)
  if (!amountMatch) return null
  const currency = amountMatch[1]!.toUpperCase()
  if (!isCurrency(currency)) return null

  let amountMinor: bigint
  try {
    amountMinor = parseAmountInput(amountMatch[2]!, currency).amountMinor
  } catch {
    return null
  }

  const counterpartyLabel = TRANSFER_PAYEE.exec(text)?.[1]?.trim() ?? null

  const ts = TRANSFER_TIMESTAMP.exec(text)
  const month = ts ? monthIndex(ts[2]!) : null
  const occurredAt = ts && month
    ? offsetDateTime(Number(ts[3]), month, Number(ts[1]), Number(ts[4]), Number(ts[5]), 0, 8)
    : null

  const fields: ParsedTransfer = {
    kind: 'transfer',
    amountMinor,
    currency,
    accountLast4: null,
    accountRole: 'source',
    counterpartyLabel,
    occurredAt,
    description: 'Mox transfer',
  }

  return {
    parserId: 'mox-transfer',
    confidence: 0.85,
    fields,
    notes: counterpartyLabel ? [] : ['no payee identifier found'],
  }
}

export const moxParser: Parser = {
  id: 'mox',

  matches(message: EmailMessage): boolean {
    return isFrom(message)
  },

  parse(message: EmailMessage): ParseResult | null {
    return parseTrade(message) ?? parseTransfer(message)
  },
}
