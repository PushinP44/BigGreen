/**
 * HSBC HK — the one institution PLAN §7.0 already knew sends usable
 * per-transaction email. Four distinct templates arrive from the same
 * `notification.hsbc.com.hk` sender, each with its own dedicated notice type
 * (and, for every one of them, an untranslated duplicate of the same content
 * in Chinese further down the message — the regexes below only ever need the
 * English section, since it always comes first).
 *
 * Every English/Chinese pair repeats the *same* values rather than different
 * ones, so matching the first occurrence of a label is correct, not lucky.
 *
 * Pure: no I/O, no clock.
 */

import { findLabeledAmount, findLabeledValue, offsetDateTime } from './shared'
import type { EmailMessage, ParsedTransfer, ParseResult, Parser } from './types'

const SENDER = /hsbc/i

function isFrom(message: EmailMessage): boolean {
  return SENDER.test(message.from)
}

// ── Card-not-present transaction alert ──────────────────────────────────────
//
// "HSBC Credit Card Transaction Notification" — an ordinary card purchase.
// The one shape PLAN §7.0 already had in mind when the generic parser was
// written; this replaces the generic heuristic with the exact labels HSBC
// uses, which is far more confident and sidesteps a real bug in the generic
// LAST4 regex (it requires `ending 1234` with no punctuation in between, but
// HSBC actually writes "Ending with 1234" and "ending: 1234" — a colon the
// generic pattern does not expect).

const CNP_SIGNAL = /card-not-present/i
const CNP_LAST4 = /Ending with\s*(\d{4})/i
const CNP_MERCHANT_LABEL = /\bMerchant\b/i
const CNP_MERCHANT_VALUE = /^\s*([A-Z0-9][^\n]{1,58})/
const CNP_AMOUNT_LABEL = /\bAmount\b/i
const CREDIT_HINTS = /\b(refund|reversal|credited|received)\b/i

function parseCnpTransaction(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!CNP_SIGNAL.test(text)) return null

  const amount = findLabeledAmount(text, CNP_AMOUNT_LABEL)
  if (!amount) return null

  const notes: string[] = []

  const last4 = CNP_LAST4.exec(text)?.[1] ?? null
  if (!last4) notes.push('no card number found')

  const merchant = findLabeledValue(text, CNP_MERCHANT_LABEL, CNP_MERCHANT_VALUE)
  if (!merchant) notes.push('no merchant found')

  // The template is purpose-built for card-not-present purchases; a refund
  // would be unusual through this exact notice, but the wording is checked
  // anyway rather than assumed, for the same reason generic.ts does.
  const isCredit = CREDIT_HINTS.test(text)

  let confidence = 0.85
  if (last4) confidence += 0.08
  if (merchant) confidence += 0.07

  return {
    parserId: 'hsbc-cnp-transaction',
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    fields: {
      kind: 'transaction',
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      direction: isCredit ? 'income' : 'spend',
      merchant,
      accountLast4: last4,
      // Only a day-and-month is given ("12 May"), no year — inferring one
      // risks a wrong-year bug on a January email about a December charge.
      // The email date is close enough for a same-day alert.
      occurredAt: null,
      description: merchant ?? 'HSBC card transaction',
    },
    notes,
  }
}

// ── Direct debit authorisation payment advice ───────────────────────────────
//
// A recurring debit you already authorised (insurance, a subscription).
// "Payee name" in the one sample seen is the account holder's own masked
// name, not a biller — surfacing it as `merchant` would be actively
// misleading, so it is deliberately left out. Revisit if a sample turns up
// where this field is unambiguously a third party.

const DEBIT_SIGNAL = /direct debit/i
const DEBIT_AMOUNT_LABEL = /Payment amount/i
const DEBIT_DATE = /Payment date:?\s*\n?\s*(\d{4})-(\d{2})-(\d{2})/

function parseDirectDebit(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!DEBIT_SIGNAL.test(text)) return null

  const amount = findLabeledAmount(text, DEBIT_AMOUNT_LABEL)
  if (!amount) return null

  const dateMatch = DEBIT_DATE.exec(text)

  return {
    parserId: 'hsbc-direct-debit',
    confidence: 0.9,
    fields: {
      kind: 'transaction',
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      // "We've debited your account" is unambiguous — this template has no
      // credit variant.
      direction: 'spend',
      merchant: null,
      accountLast4: null,
      occurredAt: dateMatch
        ? offsetHkDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]))
        : null,
      description: 'HSBC direct debit',
    },
    notes: ['no merchant — HSBC direct debit advices name the debit account, not the payee'],
  }
}

// ── "You've paid your card" — a credit-card bill payment ───────────────────
//
// This is a transfer between two of your own accounts (whichever account
// paid it, into the card), never a purchase. Getting this wrong is the one
// truly dangerous case in this file: if it were parsed as a plain 'spend'
// against the card (as the generic parser would, reading "Payment date" as a
// DEBIT_HINTS match), a *confident* card-last4 match could auto-post it as
// a purchase — doubling what the card appears to owe, silently, since
// review only offers confirm/discard, not correction.
//
// Modelled as a transfer instead: the card is the one side the message
// names explicitly (`accountLast4`), and `counterpartyLabel: 'HSBC'` states
// the one fact this notice actually gives about the other side — that it
// came from another HSBC account of yours. `lib/ingest/email.ts` only
// resolves that to a real account when exactly one other HSBC account
// exists, and transfers never auto-post regardless (both legs have to be
// right, and there's no way to fix a wrong one after the fact) — so this
// can surface as a same-day pending review, but never as silent double
// counting.

const PAID_CARD_SIGNAL = /paid your card/i
const PAID_CARD_LAST4 = /Credit Card number ending:?\s*\n?\s*(\d{4})/i
const PAID_CARD_AMOUNT_LABEL = /Transfer amount/i
const PAID_CARD_DATE = /Payment date:?\s*\n?\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/

function parsePaidCard(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!PAID_CARD_SIGNAL.test(text)) return null

  const amount = findLabeledAmount(text, PAID_CARD_AMOUNT_LABEL)
  const last4 = PAID_CARD_LAST4.exec(text)?.[1] ?? null
  // With no card number this notice gives nothing an account can be
  // resolved against, and there's nothing safe to fall back to.
  if (!amount || !last4) return null

  const dateMatch = PAID_CARD_DATE.exec(text)

  const fields: ParsedTransfer = {
    kind: 'transfer',
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    accountLast4: last4,
    accountRole: 'destination',
    counterpartyLabel: 'HSBC',
    occurredAt: dateMatch
      ? offsetHkDate(
          Number(dateMatch[1]),
          Number(dateMatch[2]),
          Number(dateMatch[3]),
          Number(dateMatch[4]),
          Number(dateMatch[5]),
        )
      : null,
    description: 'HSBC credit card payment',
  }

  return {
    parserId: 'hsbc-card-payment',
    // Everything this notice can give is present by construction (both
    // matches required above); confidence still stays capped downstream by
    // the transfer rule in lib/ingest/email.ts regardless of this number.
    confidence: 0.9,
    fields,
    notes: [],
  }
}

// ── "Successful payment transfer" — an outgoing FPS/payee payment ──────────
//
// Could be to a third party or to one of your own other accounts; this
// template never names the payee, only an opaque FPS proxy or account
// number. `counterpartyLabel` carries that raw text forward honestly, but
// it will essentially never resolve to a real account (no institution is
// ever mentioned), so this lands as unparsed — manual entry — until proven
// otherwise by a sample that actually names something matchable.

const TRANSFER_SIGNAL = /successful payment transfer|payee account\s*\/\s*fps proxy/i
const TRANSFER_AMOUNT_LABEL = /Payment amount/i
const TRANSFER_PAYEE_LABEL = /Payee account\s*\/\s*FPS proxy:?/i
const TRANSFER_PAYEE_VALUE = /^\s*\n?\s*([A-Za-z0-9][A-Za-z0-9*Xx-]{2,24})/
const TRANSFER_DATE = /Payment date:?\s*\n?\s*(\d{4})-(\d{2})-(\d{2})/

function parsePaymentTransfer(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!TRANSFER_SIGNAL.test(text)) return null

  const amount = findLabeledAmount(text, TRANSFER_AMOUNT_LABEL)
  if (!amount) return null

  const counterpartyLabel = findLabeledValue(text, TRANSFER_PAYEE_LABEL, TRANSFER_PAYEE_VALUE)
  const dateMatch = TRANSFER_DATE.exec(text)

  const fields: ParsedTransfer = {
    kind: 'transfer',
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    // No last-4 in this template — "Debit account no.: 123-456XXX-XXX" is a
    // front-masked account number, not the last-4 shape `accountLast4`
    // means elsewhere in this codebase.
    accountLast4: null,
    accountRole: 'source',
    counterpartyLabel,
    occurredAt: dateMatch
      ? offsetHkDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]))
      : null,
    description: 'HSBC payment transfer',
  }

  return {
    parserId: 'hsbc-payment-transfer',
    confidence: 0.85,
    fields,
    notes: counterpartyLabel ? [] : ['no payee identifier found'],
  }
}

function offsetHkDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date | null {
  return offsetDateTime(year, month, day, hour, minute, 0, 8)
}

export const hsbcParser: Parser = {
  id: 'hsbc',

  matches(message: EmailMessage): boolean {
    return isFrom(message)
  },

  parse(message: EmailMessage): ParseResult | null {
    return (
      parseCnpTransaction(message) ??
      parseDirectDebit(message) ??
      parsePaidCard(message) ??
      parsePaymentTransfer(message)
    )
  },
}
