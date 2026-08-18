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
 *
 * A third property is specific to transfers and trades: **`/review` can only
 * confirm or discard, never correct.** A spend/income parse's only real risk
 * is a wrong sign or a wrong system category, both cheap mistakes; a transfer
 * or trade risks filing real money against the wrong *account* or the wrong
 * *instrument*, which review cannot fix after the fact. So both kinds resolve
 * every account (and, for a trade, the instrument) with certainty *before*
 * anything is written, and refuse — `unparsed`, not a guess — the moment that
 * isn't possible. Confidence is capped low enough that neither kind ever
 * auto-posts by default, regardless of how sure the parser itself was.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Db } from '@/lib/db/client'
import { balanceEntries, type EntryInput } from '@/lib/domain/fx'
import { parseQuantity, quantityToString } from '@/lib/domain/holdings'
import { BASE_CURRENCY, parseRate, RATE_ONE, rateToString, type Currency, type Rate } from '@/lib/domain/money'
import { institutionFromText, parseEmail, type EmailMessage, type RegistryResult } from '@/lib/parsers/registry'
import type { ParsedTrade, ParsedTransfer } from '@/lib/parsers/types'
import { findSystemAccountId, rateTableFor } from '@/lib/read/accounts'

/** Default bar for posting without review. Overridable in settings. */
export const DEFAULT_AUTOPOST_CONFIDENCE = 0.9

/**
 * A transfer or a trade against a newly-resolved (not last-4-certain, or
 * newly-created) counterpart never crosses this regardless of the owner's
 * own `autoPostConfidence` setting — unlike the plain spend/income path,
 * where a lower owner-set bar is respected. The difference is `/review`:
 * confirming a wrong spend just posts a wrong category; confirming a wrong
 * transfer or trade posts real money against the wrong account, with no way
 * to correct it after the fact. That risk is not the owner's to opt out of
 * from Settings — only the confidence-worthy cases (both legs last-4-certain,
 * or an already-known instrument) are, and even then it still respects the
 * owner's bar normally.
 */
const TRANSFER_TRADE_CONFIDENCE_CAP = 0.85

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
  const { accountLast4, currency } = parsed.fields

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

/**
 * The other side of a transfer. Only ever matched by institution keyword
 * against your *other* own accounts in the same currency — never by number,
 * since none of these templates give enough of the counterparty's account
 * number to match on. A label that names no institution (a bare phone
 * number, an opaque FPS proxy) correctly never resolves: guessing "this
 * transfer must be to one of your own accounts" would misfile every ordinary
 * payment to a friend as a self-transfer.
 */
async function resolveCounterpartyAccount(
  db: Db,
  fields: ParsedTransfer,
  primaryAccountId: string,
): Promise<string | null> {
  if (!fields.counterpartyLabel) return null
  const institution = institutionFromText(fields.counterpartyLabel)
  if (!institution) return null

  const result = await db.query<{ id: string }>(
    `SELECT id FROM accounts
      WHERE is_own AND archived_at IS NULL AND id <> $1
        AND institution = $2 AND currency = $3`,
    [primaryAccountId, institution, fields.currency],
  )
  return result.rows.length === 1 ? result.rows[0]!.id : null
}

/**
 * The instrument a trade's cash leg pairs with. Matched by symbol or ISIN
 * first — a repeat trade of something you already hold must land on the same
 * `instruments` row, not a duplicate one that splits the position in two.
 * Auto-created when nothing matches, since blocking every *first* trade of
 * something on manual entry would defeat most of the point of parsing these
 * at all; the caller is expected to treat a freshly-created instrument as a
 * reason to require review rather than auto-post, since there is nothing yet
 * to have matched *correctly*.
 */
async function resolveOrCreateInstrument(
  db: Db,
  fields: ParsedTrade,
): Promise<{ instrumentId: string; isNew: boolean }> {
  const symbol = fields.symbol.trim().toUpperCase()

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM instruments WHERE symbol = $1 OR (isin IS NOT NULL AND isin = $2) LIMIT 1`,
    [symbol, fields.isin],
  )
  const existingId = existing.rows[0]?.id
  if (existingId) return { instrumentId: existingId, isNew: false }

  const userId = await currentUserId(db)
  const created = await db.query<{ id: string }>(
    `INSERT INTO instruments (user_id, symbol, isin, kind, currency)
     VALUES ($1, $2, $3, $4::instrument_kind, $5)
     RETURNING id`,
    [userId, symbol, fields.isin, fields.instrumentKind, fields.currency],
  )
  const createdId = created.rows[0]?.id
  if (!createdId) throw new Error(`failed to create instrument ${symbol}`)
  return { instrumentId: createdId, isNew: true }
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
  if (!account) {
    // Nothing to book against, so nothing can be written — the ledger has no
    // way to represent "a transaction on an unknown account" and still balance.
    return { kind: 'unparsed', reason: 'no matching account' }
  }

  const reasons = [...parsed.notes]
  if (!account.certain) reasons.push('account inferred from the sender, not a card number')

  // Confidence in the parse is not confidence in the transaction: a perfectly
  // read amount filed against the wrong account is still wrong.
  let effectiveConfidence = account.certain ? parsed.confidence : Math.min(parsed.confidence, 0.85)

  let counterpartyAccountId: string | undefined
  let instrumentId: string | undefined

  if (parsed.fields.kind === 'transfer') {
    const resolved = await resolveCounterpartyAccount(db, parsed.fields, account.accountId)
    if (!resolved) {
      // Never guess the other side of a transfer — a wrong account here
      // can't be corrected by review, only confirmed or discarded whole.
      return { kind: 'unparsed', reason: 'could not identify the other side of this transfer' }
    }
    counterpartyAccountId = resolved
    effectiveConfidence = Math.min(effectiveConfidence, TRANSFER_TRADE_CONFIDENCE_CAP)
  } else if (parsed.fields.kind === 'trade') {
    const instrument = await resolveOrCreateInstrument(db, parsed.fields)
    instrumentId = instrument.instrumentId
    if (instrument.isNew) {
      reasons.push(
        'instrument not seen before — created from this email; check the symbol against any existing holding',
      )
      effectiveConfidence = Math.min(effectiveConfidence, TRANSFER_TRADE_CONFIDENCE_CAP)
    }
  }

  const shouldPost = effectiveConfidence >= bar

  const transactionId = await writeTransaction(db, {
    accountId: account.accountId,
    counterpartyAccountId,
    instrumentId,
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
  /** Set only when `parsed.fields.kind === 'transfer'`; resolved by the caller. */
  counterpartyAccountId: string | undefined
  /** Set only when `parsed.fields.kind === 'trade'`; resolved by the caller. */
  instrumentId: string | undefined
  parsed: RegistryResult
  message: EmailMessage
  status: 'posted' | 'pending'
  confidence: number
  reasons: readonly string[]
  now: Date
}

async function writeTransaction(db: Db, input: WriteInput): Promise<string> {
  const { fields } = input.parsed
  const currency = fields.currency
  const rate = await rateFor(db, currency)
  const fxRoundingAccountId = await findSystemAccountId(db, 'fx_rounding')

  let entryInputs: EntryInput[]
  let merchant: string | null = null

  switch (fields.kind) {
    case 'transaction': {
      const counterpartyId = await findSystemAccountId(
        db,
        fields.direction === 'spend' ? 'expense' : 'income',
      )
      const sign = fields.direction === 'spend' ? -1n : 1n
      entryInputs = [
        { accountId: input.accountId, amountMinor: sign * fields.amountMinor, currency, fxRateToHkd: rate },
        { accountId: counterpartyId, amountMinor: -sign * fields.amountMinor, currency, fxRateToHkd: rate },
      ]
      merchant = fields.merchant
      break
    }

    case 'transfer': {
      const counterpartyAccountId = input.counterpartyAccountId
      if (!counterpartyAccountId) throw new Error('transfer is missing its resolved counterparty account')
      // Source: money leaves this account (negative). Destination: the reverse.
      const sign = fields.accountRole === 'source' ? -1n : 1n
      entryInputs = [
        { accountId: input.accountId, amountMinor: sign * fields.amountMinor, currency, fxRateToHkd: rate },
        {
          accountId: counterpartyAccountId,
          amountMinor: -sign * fields.amountMinor,
          currency,
          fxRateToHkd: rate,
        },
      ]
      break
    }

    case 'trade': {
      const instrumentId = input.instrumentId
      if (!instrumentId) throw new Error('trade is missing its resolved instrument')
      // Both legs sit on the same (brokerage) account: cash leg unadorned,
      // instrument leg carrying instrument_id/quantity_delta at the mirrored
      // amount — the account's own balance is unchanged by a buy, cash just
      // converts into a position. Same convention as lib/ledger/instruments.ts's
      // recordTrade, duplicated here rather than reused because that module's
      // writer hardcodes source='manual' and status='posted', neither of which
      // fits an email-ingested, possibly-pending row.
      const quantity = parseQuantity(fields.quantity)
      if (quantity.scaled <= 0n) throw new Error('trade quantity must be greater than zero')
      const cashSign = fields.side === 'buy' ? -1n : 1n
      const signedQuantity = fields.side === 'buy' ? quantity.scaled : -quantity.scaled
      entryInputs = [
        {
          accountId: input.accountId,
          amountMinor: cashSign * fields.amountMinor,
          currency,
          fxRateToHkd: rate,
        },
        {
          accountId: input.accountId,
          amountMinor: -cashSign * fields.amountMinor,
          currency,
          fxRateToHkd: rate,
          instrumentId,
          quantityDelta: quantityToString({ scaled: signedQuantity }),
        },
      ]
      break
    }
  }

  const balanced = balanceEntries(entryInputs, { fxRoundingAccountId })
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
        merchant,
        input.message.messageId,
        notes,
      ],
    )

    for (const entry of balanced.entries) {
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

  return transactionId
}

async function rateFor(db: Db, currency: Currency): Promise<Rate> {
  if (currency === BASE_CURRENCY) return RATE_ONE
  return parseRate(
    (await rateTableFor(db))[currency] ??
      (() => {
        throw new Error(`no ${currency}/${BASE_CURRENCY} rate available`)
      })(),
  )
}

async function currentUserId(db: Db): Promise<string> {
  const result = await db.query<{ uid: string | null }>('SELECT auth.uid() AS uid')
  const uid = result.rows[0]?.uid
  if (!uid) throw new Error('no authenticated user in session')
  return uid
}
