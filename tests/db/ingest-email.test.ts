import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestEmail, verifySignature } from '@/lib/ingest/email'
import type { Db } from '@/lib/db/client'
import type { EmailMessage } from '@/lib/parsers/types'
import { createTestDb, seedAccounts, USER_A, type SeededAccounts, type TestDb } from '../support/db'

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/emails', name), 'utf8')
}

async function insertAccount(
  db: Db,
  opts: {
    name: string
    kind: string
    currency: string
    institution: string | null
    last4?: string | null
    isLiquid?: boolean
  },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, institution, account_last4)
     VALUES ($1, $2, $3::account_kind, $4, $5, true, $6, $7)
     RETURNING id`,
    [
      USER_A,
      opts.name,
      opts.kind,
      opts.currency,
      opts.isLiquid ?? true,
      opts.institution,
      opts.last4 ?? null,
    ],
  )
  return result.rows[0]!.id
}

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

describe('transfers', () => {
  it('books a credit-card payment as a real transfer, against both real accounts', async () => {
    // cardId (institution=hsbc, last4=4321) already exists from the outer
    // beforeEach; a second HSBC account is what "paid your card" needs on
    // the other side.
    const bankId = await insertAccount(db, {
      name: 'HSBC Everyday',
      kind: 'bank',
      currency: 'HKD',
      institution: 'hsbc',
    })

    const outcome = await ingestEmail(
      db,
      email({
        from: 'HSBC@notification.hsbc.com.hk',
        subject: "You've paid your card Ref:[TEST0003]",
        body: fixture('hsbc-card-payment.txt'),
      }),
      { autoPostConfidence: 0.9 },
    )

    // Both legs resolve, but a transfer never auto-posts at the default bar —
    // review can only confirm or discard, never correct a wrong account.
    expect(outcome.kind).toBe('pending')

    const entries = await db.query<{ account_id: string; amount_minor: string }>(
      `SELECT account_id, amount_minor::text AS amount_minor FROM entries ORDER BY amount_minor::bigint`,
    )
    expect(entries.rows).toHaveLength(2)
    expect(entries.rows).toContainEqual({ account_id: bankId, amount_minor: '-400000' })
    expect(entries.rows).toContainEqual({ account_id: cardId, amount_minor: '400000' })

    const total = await db.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount_hkd_minor), 0)::text AS total FROM entries',
    )
    expect(BigInt(total.rows[0]!.total)).toBe(0n)
  })

  it('refuses to guess the source account when only the card itself exists', async () => {
    // No second HSBC account this time — nothing for "HSBC" (the only fact
    // the notice gives about the source) to resolve to.
    const outcome = await ingestEmail(
      db,
      email({
        from: 'HSBC@notification.hsbc.com.hk',
        subject: "You've paid your card Ref:[TEST0003]",
        body: fixture('hsbc-card-payment.txt'),
      }),
    )
    expect(outcome.kind).toBe('unparsed')

    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM transactions')
    expect(count.rows[0]!.n).toBe(0)
  })

  it('never guesses a same-institution counterparty for an opaque proxy/phone number', async () => {
    await insertAccount(db, { name: 'HSBC Everyday', kind: 'bank', currency: 'HKD', institution: 'hsbc' })

    // "Payee account / FPS proxy: 98XXXX123" names no institution at all —
    // guessing it must be another HSBC account would misfile an ordinary
    // payment to a friend as a self-transfer.
    const outcome = await ingestEmail(
      db,
      email({
        from: 'HSBC@notification.hsbc.com.hk',
        subject: 'Successful payment transfer Ref:[TEST0004]',
        body: fixture('hsbc-payment-transfer.txt'),
      }),
    )
    expect(outcome.kind).toBe('unparsed')
  })

  it('resolves a transfer to an institution named in the payee label (Mox -> ZA)', async () => {
    const moxId = await insertAccount(db, { name: 'Mox HKD', kind: 'bank', currency: 'HKD', institution: 'mox' })
    const zaId = await insertAccount(db, { name: 'ZA HKD', kind: 'bank', currency: 'HKD', institution: 'za' })

    const outcome = await ingestEmail(
      db,
      email({
        from: 'Mox <notify@mox.com>',
        subject: 'Money transfer successful',
        body: fixture('mox-transfer.txt'),
      }),
    )
    expect(outcome.kind).toBe('pending')

    const entries = await db.query<{ account_id: string; amount_minor: string }>(
      `SELECT account_id, amount_minor::text AS amount_minor FROM entries ORDER BY amount_minor::bigint`,
    )
    expect(entries.rows).toContainEqual({ account_id: moxId, amount_minor: '-440000' })
    expect(entries.rows).toContainEqual({ account_id: zaId, amount_minor: '440000' })
  })

  it('is idempotent — re-ingesting the same transfer email never doubles it', async () => {
    await insertAccount(db, { name: 'HSBC Everyday', kind: 'bank', currency: 'HKD', institution: 'hsbc' })

    const msg = email({
      from: 'HSBC@notification.hsbc.com.hk',
      subject: "You've paid your card Ref:[TEST0003]",
      body: fixture('hsbc-card-payment.txt'),
    })

    const first = await ingestEmail(db, msg)
    const second = await ingestEmail(db, msg)
    expect(first.kind).toBe('pending')
    expect(second.kind).toBe('duplicate')

    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM transactions')
    expect(count.rows[0]!.n).toBe(1)
  })
})

describe('trades', () => {
  it('creates a new instrument on a first-ever trade and books both legs on the brokerage account', async () => {
    const brokerageId = await insertAccount(db, {
      name: 'ZA Invest USD',
      kind: 'brokerage',
      currency: 'USD',
      institution: 'za',
      isLiquid: false,
    })
    await db.query(
      `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
       VALUES ($1, 'USD', 'HKD', '2026-08-13', 7.8, 'manual')`,
      [USER_A],
    )

    const outcome = await ingestEmail(
      db,
      email({
        from: 'ZA Bank <notification@service.bank.za.group>',
        subject: 'Fully executed - Buy order of GRAB (Grab Holdings)',
        body: fixture('za-trade-buy.txt'),
      }),
      { autoPostConfidence: 0.9 },
    )

    // A brand-new instrument, and an account resolved only by institution
    // (no last-4 is ever given for a brokerage alert) — both keep this below
    // the default auto-post bar.
    expect(outcome.kind).toBe('pending')

    const instruments = await db.query<{ id: string; symbol: string; kind: string; currency: string }>(
      `SELECT id, symbol, kind::text AS kind, currency FROM instruments`,
    )
    expect(instruments.rows).toHaveLength(1)
    expect(instruments.rows[0]).toMatchObject({ symbol: 'GRAB', kind: 'stock', currency: 'USD' })
    const instrumentId = instruments.rows[0]!.id

    const entries = await db.query<{
      amount_minor: string
      instrument_id: string | null
      quantity_delta: string | null
    }>(
      `SELECT amount_minor::text AS amount_minor, instrument_id, quantity_delta::text AS quantity_delta
         FROM entries WHERE account_id = $1 ORDER BY amount_minor::bigint`,
      [brokerageId],
    )
    expect(entries.rows).toHaveLength(2)
    // Cash leg: -10830 (USD108.30 = 30 shares @ USD3.6100, computed since ZA
    // never states a total). Instrument leg: the mirrored positive amount,
    // carrying the position.
    expect(entries.rows[0]).toMatchObject({ amount_minor: '-10830', instrument_id: null })
    expect(entries.rows[1]).toMatchObject({
      amount_minor: '10830',
      instrument_id: instrumentId,
      quantity_delta: '30.0000000000',
    })

    // The account's own balance nets to zero — cash converted into a
    // position, no new money entered.
    const total = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM entries WHERE account_id = $1`,
      [brokerageId],
    )
    expect(BigInt(total.rows[0]!.total)).toBe(0n)
  })

  it('matches an existing instrument by symbol rather than creating a duplicate', async () => {
    await insertAccount(db, {
      name: 'ZA Invest USD',
      kind: 'brokerage',
      currency: 'USD',
      institution: 'za',
      isLiquid: false,
    })
    const existing = await db.query<{ id: string }>(
      `INSERT INTO instruments (user_id, symbol, kind, currency) VALUES ($1, 'GRAB', 'stock', 'USD') RETURNING id`,
      [USER_A],
    )
    const existingId = existing.rows[0]!.id
    await db.query(
      `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
       VALUES ($1, 'USD', 'HKD', '2026-08-13', 7.8, 'manual')`,
      [USER_A],
    )

    await ingestEmail(
      db,
      email({
        from: 'ZA Bank <notification@service.bank.za.group>',
        subject: 'Fully executed - Buy order of GRAB (Grab Holdings)',
        body: fixture('za-trade-buy.txt'),
      }),
    )

    const instruments = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM instruments')
    expect(instruments.rows[0]!.n).toBe(1)

    const linked = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM entries WHERE instrument_id = $1',
      [existingId],
    )
    expect(linked.rows[0]!.n).toBe(1)
  })

  it('refuses to trade against an account it cannot identify', async () => {
    // No ZA brokerage account seeded at all.
    const outcome = await ingestEmail(
      db,
      email({
        from: 'ZA Bank <notification@service.bank.za.group>',
        subject: 'Fully executed - Buy order of GRAB (Grab Holdings)',
        body: fixture('za-trade-buy.txt'),
      }),
    )
    expect(outcome.kind).toBe('unparsed')

    const instruments = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM instruments')
    expect(instruments.rows[0]!.n).toBe(0)
  })

  it('records a sell using the stated total, not a computed one', async () => {
    const brokerageId = await insertAccount(db, {
      name: 'Mox Invest HKD',
      kind: 'brokerage',
      currency: 'HKD',
      institution: 'mox',
      isLiquid: false,
    })

    await ingestEmail(
      db,
      email({
        from: 'Mox <notify@mox.com>',
        subject: 'Sell executed',
        body: fixture('mox-trade-sell.txt'),
      }),
    )

    const entries = await db.query<{ amount_minor: string; quantity_delta: string | null }>(
      `SELECT amount_minor::text AS amount_minor, quantity_delta::text AS quantity_delta
         FROM entries WHERE account_id = $1 ORDER BY amount_minor::bigint`,
      [brokerageId],
    )
    // Proceeds of HKD4,502.16 in, a -400 unit position leg out.
    expect(entries.rows).toContainEqual({ amount_minor: '450216', quantity_delta: null })
    expect(entries.rows.some((r) => r.quantity_delta === '-400.0000000000')).toBe(true)
  })
})
