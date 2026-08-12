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

export interface ParsedTransaction {
  /** Minor units, always positive. `direction` carries the sign. */
  readonly amountMinor: bigint
  readonly currency: Currency
  readonly direction: 'spend' | 'income'
  readonly merchant: string | null
  /** Last 4 digits of the card or account, when the message states them. */
  readonly accountLast4: string | null
  /** When the bank says it happened; null means fall back to the email date. */
  readonly occurredAt: Date | null
  readonly description: string
}

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
