/**
 * Email parsing — types and the confidence contract.
 *
 * PLAN rev 5 reinstates parsing, which rev 3 had cut. The reason it is back is
 * narrow and concrete: the cards and banks email you, and typing every card
 * transaction by hand is the friction most likely to kill the habit.
 *
 * The rule rev 3 relaxed is therefore live again — a parsed field is a claim,
 * not a fact. Confidence is what decides whether a claim is good enough to post
 * without you looking at it, so it has to mean something specific rather than
 * being a number that feels about right.
 *
 * Pure: no I/O. A parser is a function from text to a claim.
 */

import type { Currency } from '@/lib/domain/money'

interface ParsedBase {
  /** When the bank says it happened; null means fall back to the email date. */
  readonly occurredAt: Date | null
  readonly description: string
}

/** An ordinary card purchase, refund, or debit against one of your accounts. */
export interface ParsedSpend extends ParsedBase {
  readonly kind: 'transaction'
  /** Minor units, always positive. `direction` carries the sign. */
  readonly amountMinor: bigint
  readonly currency: Currency
  readonly direction: 'spend' | 'income'
  readonly merchant: string | null
  /** Last 4 digits of the card or account, when the message states them. */
  readonly accountLast4: string | null
}

/**
 * Money moving between two accounts — a credit-card bill payment, an FPS/
 * PromptPay transfer. Deliberately does not carry a resolved counterparty
 * *account*: a parser is pure text-in claim-out and has no database to check
 * against. `counterpartyLabel` is only ever the raw signal the message gives
 * (a payee name, a phone number, an institution mention) — resolving it to a
 * real account, or refusing to, is `lib/ingest/email.ts`'s job.
 */
export interface ParsedTransfer extends ParsedBase {
  readonly kind: 'transfer'
  readonly amountMinor: bigint
  readonly currency: Currency
  /** Last 4 of the account this alert names explicitly, when it names one. */
  readonly accountLast4: string | null
  /** Which way money moved relative to the `accountLast4` account. */
  readonly accountRole: 'source' | 'destination'
  /**
   * Free-text signal about the *other* side. Never assumed to be a real
   * account — the ingest layer tries to match it against your own accounts
   * and refuses to post when it can't, rather than guess.
   */
  readonly counterpartyLabel: string | null
}

/** A brokerage buy or sell — the cash leg and the instrument leg together. */
export interface ParsedTrade extends ParsedBase {
  readonly kind: 'trade'
  readonly side: 'buy' | 'sell'
  /** Ticker or fund identifier, as the message gives it — normalised by the ingest layer. */
  readonly symbol: string
  readonly isin: string | null
  readonly instrumentKind: 'stock' | 'etf' | 'index_fund' | 'mutual_fund'
  /** Decimal string, e.g. "30" or "400.0000" — matches `lib/domain/holdings.ts`'s `parseQuantity`. */
  readonly quantity: string
  /** Total cash moved: cost for a buy, proceeds for a sell. */
  readonly amountMinor: bigint
  readonly currency: Currency
  /** Brokerage account last 4, when the message states it. */
  readonly accountLast4: string | null
}

export type ParsedTransaction = ParsedSpend | ParsedTransfer | ParsedTrade

/**
 * Confidence is the probability that posting this unreviewed is safe.
 *
 * Scored from what was actually found, not from how well a regex matched:
 * an amount and a currency are the difference between a usable transaction and
 * a guess, so they dominate. A parser that cannot find an amount returns null
 * rather than a low score — there is nothing to post either way, and a 0.2
 * would imply a transaction exists to review.
 */
export interface ParseResult {
  readonly parserId: string
  readonly confidence: number
  readonly fields: ParsedTransaction
  /** Why the confidence is what it is, surfaced in the review queue. */
  readonly notes: readonly string[]
}

export interface EmailMessage {
  /** Gmail message id — the idempotency key. */
  readonly messageId: string
  readonly from: string
  readonly subject: string
  /** Plain text; the Apps Script strips HTML before sending. */
  readonly body: string
  readonly receivedAt: Date
}

export interface Parser {
  readonly id: string
  /** Cheap test so the registry can skip parsers that cannot apply. */
  matches(message: EmailMessage): boolean
  parse(message: EmailMessage): ParseResult | null
}
