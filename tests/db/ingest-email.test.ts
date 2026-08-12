import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestEmail, verifySignature } from '@/lib/ingest/email'
import type { Db } from '@/lib/db/client'
import type { EmailMessage } from '@/lib/parsers/types'
import { createTestDb, seedAccounts, USER_A, type SeededAccounts, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db
let accounts: SeededAccounts
let cardId: string

const SECRET = 'test-secret'

function sign(body: string, timestamp: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

function email(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    messageId: 'gmail-1',
    from: 'alerts@hsbc.com.hk',
    subject: 'Card transaction alert',
    body: 'A purchase of HKD 248.50 at: PARK N SHOP was made with card ending 4321.',
    receivedAt: new Date('2026-08-12T04:00:00Z'),
    ...overrides,
  }
}

beforeEach(async () => {
  testDb = await createTestDb()
  accounts = await seedAccounts(testDb, USER_A)
  db = await testDb.asDb(USER_A)

  const card = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, institution, account_last4)
     VALUES ($1, 'HSBC Credit Card', 'credit_card', 'HKD', false, true, 'hsbc', '4321')
     RETURNING id`,
    [USER_A],
  )
  cardId = card.rows[0]!.id
})

afterEach(async () => {
  await testDb.close()
})

describe('signature verification', () => {
  const body = '{"a":1}'

  it('accepts a correct signature', () => {
    const ts = String(Date.now())
    expect(verifySignature(body, sign(body, ts), ts, SECRET).ok).toBe(true)
  })

  it('rejects a wrong secret', () => {
    const ts = String(Date.now())
    expect(verifySignature(body, sign(body, ts, 'other'), ts, SECRET)).toEqual({
      ok: false,
      reason: 'signature mismatch',
    })
  })

  it('rejects a tampered body', () => {
    // The signature covers exact bytes, so changing one invalidates it.
    const ts = String(Date.now())
    expect(verifySignature('{"a":2}', sign(body, ts), ts, SECRET).ok).toBe(false)
  })

  it('rejects a replayed request outside the window', () => {
    const old = String(Date.now() - 10 * 60 * 1000)
    expect(verifySignature(body, sign(body, old), old, SECRET)).toEqual({
      ok: false,
      reason: 'timestamp outside replay window',
    })
  })

  it('rejects a missing signature or timestamp', () => {
    const ts = String(Date.now())
    expect(verifySignature(body, null, ts, SECRET).ok).toBe(false)
    expect(verifySignature(body, sign(body, ts), null, SECRET).ok).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on length mismatch, which would itself leak length.
    const ts = String(Date.now())
    expect(verifySignature(body, 'abc', ts, SECRET).ok).toBe(false)
  })
})

describe('ingest', () => {
  it('auto-posts a confident, unambiguous alert', async () => {
    const outcome = await ingestEmail(db, email(), { autoPostConfidence: 0.9 })
    expect(outcome.kind).toBe('posted')

    const rows = await db.query<{ status: string; source: string; external_id: string }>(
      `SELECT status::text AS status, source::text AS source, external_id FROM transactions`,
    )
    expect(rows.rows[0]).toMatchObject({ status: 'posted', source: 'email', external_id: 'gmail-1' })
  })

  it('holds an ambiguous alert as pending instead of guessing', async () => {
    // Two amounts: the charge and a quoted balance. Posting the wrong one
    // silently is exactly what the confidence bar exists to prevent.
    const outcome = await ingestEmail(
      db,
      email({
        body: 'Purchase of HKD 248.50 at: WATSONS. Available balance HKD 12,340.00.',
      }),
      { autoPostConfidence: 0.9 },
    )

    expect(outcome.kind).toBe('pending')
    const status = await db.query<{ status: string }>(
      `SELECT status::text AS status FROM transactions`,
    )
    expect(status.rows[0]?.status).toBe('pending')
  })

  it('is idempotent — the same message never posts twice', async () => {
    // The Apps Script retries freely, so this is load-bearing rather than
    // defensive.
    const first = await ingestEmail(db, email(), { autoPostConfidence: 0.9 })
    const second = await ingestEmail(db, email(), { autoPostConfidence: 0.9 })
    const third = await ingestEmail(db, email(), { autoPostConfidence: 0.9 })

    expect(first.kind).toBe('posted')
    expect(second.kind).toBe('duplicate')
    expect(third.kind).toBe('duplicate')

    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM transactions')
    expect(count.rows[0]!.n).toBe(1)
  })

  it('ignores mail with nothing to parse', async () => {
    const outcome = await ingestEmail(db, email({ body: 'Your e-statement is ready.' }))
    expect(outcome.kind).toBe('unparsed')

    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM transactions')
    expect(count.rows[0]!.n).toBe(0)
  })

  it('books against the card matched by its last four digits', async () => {
    await ingestEmail(db, email(), { autoPostConfidence: 0.9 })

    const entry = await db.query<{ account_id: string; amount_minor: string }>(
      `SELECT account_id, amount_minor::text AS amount_minor FROM entries WHERE account_id = $1`,
      [cardId],
    )
    expect(entry.rows[0]?.amount_minor).toBe('-24850')
  })

  it('leaves the ledger balanced', async () => {
    await ingestEmail(db, email(), { autoPostConfidence: 0.9 })
    const total = await db.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount_hkd_minor), 0)::text AS total FROM entries',
    )
    expect(BigInt(total.rows[0]!.total)).toBe(0n)
  })

  it('records which parser produced it and how sure it was', async () => {
    // Provenance travels with the row, so a bad parser is traceable after the
    // fact rather than merely regrettable.
    await ingestEmail(db, email(), { autoPostConfidence: 0.9 })
    const notes = await db.query<{ notes: string }>('SELECT notes FROM transactions')
    expect(notes.rows[0]?.notes).toMatch(/parser=generic confidence=1\.00/)
  })

  it('refuses to file against an account it cannot identify', async () => {
    // Better to record nothing than to book real money against a
    // plausible-looking guess.
    const outcome = await ingestEmail(
      db,
      email({ from: 'alerts@unknown-bank.com', body: 'Purchase of HKD 100.00 charged' }),
    )
    expect(outcome.kind).toBe('unparsed')
    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM transactions')
    expect(count.rows[0]!.n).toBe(0)
  })

  it('caps confidence when the account was inferred rather than matched', async () => {
    // A perfectly read amount filed against the wrong account is still wrong,
    // so an inferred account can never reach the auto-post bar.
    const outcome = await ingestEmail(
      db,
      email({
        messageId: 'gmail-2',
        body: 'Purchase of HKD 100.00 at: CITY SUPER was charged.',
      }),
      { autoPostConfidence: 0.9 },
    )
    expect(outcome.kind).toBe('pending')
    if (outcome.kind === 'pending') {
      expect(outcome.confidence).toBeLessThanOrEqual(0.85)
      expect(outcome.reasons.join(' ')).toMatch(/inferred from the sender/)
    }
  })

  it('respects a lower bar when the owner sets one', async () => {
    const outcome = await ingestEmail(
      db,
      email({
        messageId: 'gmail-3',
        body: 'Purchase of HKD 100.00 at: CITY SUPER was charged.',
      }),
      { autoPostConfidence: 0.5 },
    )
    expect(outcome.kind).toBe('posted')
  })

  it('reads a refund as income', async () => {
    await ingestEmail(
      db,
      email({
        messageId: 'gmail-4',
        body: 'A refund of HKD 120.00 has been credited to card ending 4321.',
      }),
      { autoPostConfidence: 0.5 },
    )

    const entry = await db.query<{ amount_minor: string }>(
      `SELECT amount_minor::text AS amount_minor FROM entries WHERE account_id = $1`,
      [cardId],
    )
    // Positive on the card: a refund reduces what you owe.
    expect(entry.rows[0]?.amount_minor).toBe('12000')
    expect(accounts.income).toBeTruthy()
  })
})
