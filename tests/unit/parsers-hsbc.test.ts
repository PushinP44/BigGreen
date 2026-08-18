import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hsbcParser } from '@/lib/parsers/hsbc'
import type { EmailMessage } from '@/lib/parsers/types'

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/emails', name), 'utf8')
}

function email(subject: string, fixtureName: string): EmailMessage {
  return {
    messageId: 'hsbc-1',
    from: 'HSBC <HSBC@notification.hsbc.com.hk>',
    subject,
    body: fixture(fixtureName),
    receivedAt: new Date('2026-08-12T04:00:00Z'),
  }
}

describe('hsbcParser: card-not-present transaction', () => {
  const result = hsbcParser.parse(
    email('HSBC Credit Card Transaction Notification Ref:[TEST0001]', 'hsbc-cnp-transaction.txt'),
  )

  it('reads the amount, merchant and card ending', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    expect(result.fields.amountMinor).toBe(1800n)
    expect(result.fields.currency).toBe('HKD')
    expect(result.fields.direction).toBe('spend')
    expect(result.fields.merchant).toBe('APPLE.COM/BILL')
    expect(result.fields.accountLast4).toBe('4321')
  })

  it('is confident given every field is present', () => {
    expect(result!.confidence).toBeGreaterThanOrEqual(0.95)
  })

  it('takes the first (English) occurrence, not the Chinese duplicate', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    // Both sections state the same values, so this also guards against a
    // regression where the Chinese section's numbers got picked up instead.
    expect(result.fields.amountMinor).toBe(1800n)
  })
})

describe('hsbcParser: direct debit', () => {
  const result = hsbcParser.parse(
    email('Direct debit authorisation payment advice Ref:[TEST0002]', 'hsbc-direct-debit.txt'),
  )

  it('reads the amount as an unambiguous debit, with no merchant', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    expect(result.fields.amountMinor).toBe(1_000_000n)
    expect(result.fields.currency).toBe('HKD')
    expect(result.fields.direction).toBe('spend')
    expect(result.fields.merchant).toBeNull()
  })

  it('does not surface the masked payee-name field as a merchant', () => {
    expect(result!.notes.join(' ')).toMatch(/not the payee/)
  })

  it('parses the date-only field at Hong Kong midnight', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    expect(result.fields.occurredAt?.toISOString()).toBe('2025-06-28T16:00:00.000Z')
  })
})

describe('hsbcParser: "paid your card" (own-to-own transfer)', () => {
  const result = hsbcParser.parse(email("You've paid your card Ref:[TEST0003]", 'hsbc-card-payment.txt'))

  it('is modelled as a transfer into the card, never a spend', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.amountMinor).toBe(400_000n)
    expect(result.fields.currency).toBe('HKD')
    expect(result.fields.accountLast4).toBe('4321')
    expect(result.fields.accountRole).toBe('destination')
  })

  it('states the one fact the notice actually gives about the source — that it is HSBC', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.counterpartyLabel).toBe('HSBC')
  })

  it('parses the full timestamp', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.occurredAt?.toISOString()).toBe('2025-07-09T08:52:00.000Z')
  })
})

describe('hsbcParser: successful payment transfer', () => {
  const result = hsbcParser.parse(
    email('Successful payment transfer Ref:[TEST0004]', 'hsbc-payment-transfer.txt'),
  )

  it('is a transfer with no last-4 (front-masked account numbers do not count)', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.amountMinor).toBe(10_000n)
    expect(result.fields.accountLast4).toBeNull()
    expect(result.fields.accountRole).toBe('source')
  })

  it('carries the FPS proxy forward as the counterparty label, unresolved', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    // Honest, not useful: no institution is named, so lib/ingest/email.ts
    // will never resolve this to one of the owner's own accounts — which is
    // the correct outcome for an opaque proxy ID.
    expect(result.fields.counterpartyLabel).toBe('98XXXX123')
  })
})

describe('hsbcParser: sender scoping', () => {
  it('only matches HSBC mail', () => {
    expect(
      hsbcParser.matches({
        messageId: 'x',
        from: 'notify@mox.com',
        subject: '',
        body: '',
        receivedAt: new Date(),
      }),
    ).toBe(false)
  })

  it('declines mail it does not recognise the shape of', () => {
    // A genuinely unrecognised HSBC email (no known signal phrase) should
    // decline rather than guess.
    expect(
      hsbcParser.parse({
        messageId: 'x',
        from: 'HSBC@notification.hsbc.com.hk',
        subject: 'Your e-statement is ready',
        body: 'Your e-statement is now available to view online.',
        receivedAt: new Date(),
      }),
    ).toBeNull()
  })
})
