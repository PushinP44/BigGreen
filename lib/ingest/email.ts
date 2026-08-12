import 'server-only'

/**
 * Email ingest.
 *
 * Turns a parsed bank alert into a ledger transaction, or into something you
 * look at. PLAN §7 — the confidence bar decides which, and everything below it
 * lands as `pending` rather than being dropped or guessed at.
 *
 * Two properties matter more than anything else here:
 *
 *  - **Idempotency is structural.** The Gmail message id becomes
 *    `transactions.external_id`, and `UNIQUE (user_id, source, external_id)`
 *    does the rest. Re-reading the same mailbox — which the Apps Script will do
 *    on every retry and every clock skew — cannot produce a second transaction.
 *  - **Parsed data is a claim.** Even an auto-posted transaction records which
 *    parser produced it and how confident it was, so a bad parser is traceable
 *    after the fact rather than merely regrettable.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Db } from '@/lib/db/client'
import { balanceEntries, type EntryInput } from '@/lib/domain/fx'
import { BASE_CURRENCY, parseRate, RATE_ONE, rateToString, type Currency } from '@/lib/domain/money'
import { parseEmail, type EmailMessage, type RegistryResult } from '@/lib/parsers/registry'
import { findSystemAccountId, rateTableFor } from '@/lib/read/accounts'

/** Default bar for posting without review. Overridable in settings. */
export const DEFAULT_AUTOPOST_CONFIDENCE = 0.9

/** Replay window for signed requests. */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000

export type IngestOutcome =
  | { kind: 'posted'; transactionId: string; confidence: number }
  | { kind: 'pending'; transactionId: string; confidence: number; reasons: readonly string[] }
  | { kind: 'duplicate'; transactionId: string }
  | { kind: 'unparsed'; reason: string }

export interface IngestOptions {
  readonly autoPostConfidence?: number
  readonly now?: Date
}

/**
 * Verify an HMAC-SHA256 signature over the raw body.
 *
 * Constant-time compare, and a timestamp window so a captured request cannot be
 * replayed later. The signature is the only thing that authenticates this
 * endpoint — the sender address inside the payload proves nothing, because
 * anyone can write one.
 */
export function verifySignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secret: string,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  if (!signature) return { ok: false, reason: 'missing signature' }
  if (!timestamp) return { ok: false, reason: 'missing timestamp' }

  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'invalid timestamp' }

  const age = Math.abs(now.getTime() - sentAt)
  if (age > MAX_SIGNATURE_AGE_MS) return { ok: false, reason: 'timestamp outside replay window' }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) return { ok: false, reason: 'signature mismatch' }
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' }

  return { ok: true }
}

/**
 * Pick the account this alert belongs to.
 *
 * Last-4 wins when the message states it and a card matches, because that is
 * unambiguous. Otherwise the institution narrows it, and a single matching
 * account in the right currency is taken. Anything less certain returns null,
 * and the caller holds the transaction for review rather than filing it against
 * a plausible-looking guess.
 */
export async function resolveAccount(
  db: Db,
  parsed: RegistryResult,
): Promise<{ accountId: string; certain: boolean } | null> {
  const { accountLast4, currency } = { ...parsed.fields }

  if (accountLast4) {
    const byLast4 = await db.query<{ id: string }>(
      `SELECT id FROM accounts
        WHERE is_own AND archived_at IS NULL AND account_last4 = $1`,
      [accountLast4],
    )
    if (byLast4.rows.length === 1) return { accountId: byLast4.rows[0]!.id, certain: true }
  }

  if (parsed.institution) {
    const byInstitution = await db.query<{ id: string; kind: string }>(
      `SELECT id, kind::text AS kind FROM accounts
        WHERE is_own AND archived_at IS NULL
          AND institution = $1 AND currency = $2`,
      [parsed.institution, currency],
    )

    if (byInstitution.rows.length === 1) {
      return { accountId: byInstitution.rows[0]!.id, certain: false }
    }

    // An institution commonly has several accounts — HSBC has both a current
    // account and a card. When the message mentioned a card number at all, the
    // card is the only sensible candidate, so a single card breaks the tie.
    // Without that hint, refusing is correct: real money must not be filed
    // against whichever row happened to sort first.
    if (accountLast4 !== null) {
      const cards = byInstitution.rows.filter((row) => row.kind === 'credit_card')
      if (cards.length === 1) return { accountId: cards[0]!.id, certain: false }
    }
  }

  return null
}

export async function ingestEmail(
  db: Db,
  message: EmailMessage,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const now = options.now ?? new Date()
  const bar = options.autoPostConfidence ?? DEFAULT_AUTOPOST_CONFIDENCE

  // Idempotency first: a message already seen costs one indexed lookup and
  // never re-parses. The Apps Script retries freely because of this.
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM transactions WHERE source = 'email' AND external_id = $1 LIMIT 1`,
    [message.messageId],
  )
  if (existing.rows[0]) {
    return { kind: 'duplicate', transactionId: existing.rows[0].id }
  }

  const parsed = parseEmail(message)
  if (!parsed) {
    // Statements and notices land here. Recording nothing is correct — there is
    // no transaction to review.
    return { kind: 'unparsed', reason: 'no amount found' }
  }

  const account = await resolveAccount(db, parsed)
  const reasons = [...parsed.notes]
  if (!account) reasons.push('could not tell which account this belongs to')
  else if (!account.certain) reasons.push('account inferred from the sender, not a card number')

  // Confidence in the parse is not confidence in the transaction: a perfectly
  // read amount filed against the wrong account is still wrong.
  const effectiveConfidence = account
    ? account.certain
      ? parsed.confidence
      : Math.min(parsed.confidence, 0.85)
    : 0

  const shouldPost = Boolean(account) && effectiveConfidence >= bar

  if (!account) {
    // Nothing to book against, so nothing can be written — the ledger has no
    // way to represent "a transaction on an unknown account" and still balance.
    return { kind: 'unparsed', reason: 'no matching account' }
  }

  const transactionId = await writeTransaction(db, {
    accountId: account.accountId,
    parsed,
    message,
    status: shouldPost ? 'posted' : 'pending',
    confidence: effectiveConfidence,
    reasons,
    now,
  })

  return shouldPost
    ? { kind: 'posted', transactionId, confidence: effectiveConfidence }
    : { kind: 'pending', transactionId, confidence: effectiveConfidence, reasons }
}

interface WriteInput {
  accountId: string
  parsed: RegistryResult
  message: EmailMessage
  status: 'posted' | 'pending'
  confidence: number
  reasons: readonly string[]
  now: Date
}

async function writeTransaction(db: Db, input: WriteInput): Promise<string> {
  const { fields } = input.parsed
  const currency = fields.currency as Currency

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
    fields.direction === 'spend' ? 'expense' : 'income',
  )
  const fxRoundingAccountId = await findSystemAccountId(db, 'fx_rounding')
  const sign = fields.direction === 'spend' ? -1n : 1n

  const inputs: EntryInput[] = [
    {
      accountId: input.accountId,
      amountMinor: sign * fields.amountMinor,
      currency,
      fxRateToHkd: rate,
    },
    {
      accountId: counterpartyId,
      amountMinor: -sign * fields.amountMinor,
      currency,
      fxRateToHkd: rate,
    },
  ]

  const balanced = balanceEntries(inputs, { fxRoundingAccountId })
  const transactionId = randomUUID()
  const userId = await currentUserId(db)
  const occurredAt = (fields.occurredAt ?? input.message.receivedAt).toISOString()

  // Provenance travels with the row: which parser, how confident, and what it
  // was unsure about. A bad parser then shows up as a pattern in the ledger
  // rather than as an unexplained wrong balance months later.
  const notes = [
    `parser=${input.parsed.parserId} confidence=${input.confidence.toFixed(2)}`,
    input.reasons.length ? `notes: ${input.reasons.join('; ')}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO transactions
         (id, user_id, occurred_at, status, description, merchant, source, external_id, notes)
       VALUES ($1, $2, $3, $4::transaction_status, $5, $6, 'email', $7, $8)`,
      [
        transactionId,
        userId,
        occurredAt,
        input.status,
        fields.description,
        fields.merchant,
        input.message.messageId,
        notes,
      ],
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

  return transactionId
}

async function currentUserId(db: Db): Promise<string> {
  const result = await db.query<{ uid: string | null }>('SELECT auth.uid() AS uid')
  const uid = result.rows[0]?.uid
  if (!uid) throw new Error('no authenticated user in session')
  return uid
}
