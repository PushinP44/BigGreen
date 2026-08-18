import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zaParser } from '@/lib/parsers/za'
import type { EmailMessage } from '@/lib/parsers/types'

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/emails', name), 'utf8')
}

function email(subject: string, fixtureName: string): EmailMessage {
  return {
    messageId: 'za-1',
    from: 'ZA Bank <notification@service.bank.za.group>',
    subject,
    body: fixture(fixtureName),
    receivedAt: new Date('2026-08-13T04:00:00Z'),
  }
}

describe('zaParser: card transaction', () => {
  const result = zaParser.parse(email('Your ZA Card has a transaction', 'za-card-transaction.txt'))

  it('reads the amount, merchant and card ending', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    expect(result.fields.amountMinor).toBe(816n)
    expect(result.fields.currency).toBe('HKD')
    expect(result.fields.direction).toBe('spend')
    expect(result.fields.merchant).toBe('APPLE.COM/BILL')
    expect(result.fields.accountLast4).toBe('4321')
  })

  it('parses the full timestamp', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    expect(result.fields.occurredAt?.toISOString()).toBe('2026-08-12T21:42:09.000Z')
  })
})

describe('zaParser: outgoing transfer', () => {
  const result = zaParser.parse(email("You've transferred HKD 93.00", 'za-transfer.txt'))

  it('is a transfer, sourced from the ZA account', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.amountMinor).toBe(9300n)
    expect(result.fields.currency).toBe('HKD')
    expect(result.fields.accountRole).toBe('source')
  })

  it('carries the masked phone number forward as an unresolvable counterparty', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.counterpartyLabel).toBe('+852-1234***5')
  })

  it('handles the full-width colon ZA actually sends after "Outgoing Amount"', () => {
    // Regression guard: the real template uses '：' (U+FF1A), not ':'.
    expect(fixture('za-transfer.txt')).toContain('Outgoing Amount：')
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.amountMinor).toBe(9300n)
  })
})

describe('zaParser: brokerage trade', () => {
  const result = zaParser.parse(
    email('Fully executed - Buy order of GRAB (Grab Holdings)', 'za-trade-buy.txt'),
  )

  it('reads the symbol, side and quantity', () => {
    if (result?.fields.kind !== 'trade') throw new Error('expected a trade')
    expect(result.fields.symbol).toBe('GRAB')
    expect(result.fields.side).toBe('buy')
    expect(result.fields.quantity).toBe('30')
    expect(result.fields.currency).toBe('USD')
  })

  it('computes the total from quantity × price, since ZA never states one', () => {
    if (result?.fields.kind !== 'trade') throw new Error('expected a trade')
    // 30 shares @ USD3.6100 = USD108.30
    expect(result.fields.amountMinor).toBe(10_830n)
  })
})

describe('zaParser: sender scoping', () => {
  it('only matches ZA mail', () => {
    expect(
      zaParser.matches({ messageId: 'x', from: 'HSBC@notification.hsbc.com.hk', subject: '', body: '', receivedAt: new Date() }),
    ).toBe(false)
  })

  it('declines mail it does not recognise the shape of', () => {
    expect(
      zaParser.parse({
        messageId: 'x',
        from: 'notification@service.bank.za.group',
        subject: 'Your statement is ready',
        body: 'Your monthly statement is now available in the app.',
        receivedAt: new Date(),
      }),
    ).toBeNull()
  })
})
