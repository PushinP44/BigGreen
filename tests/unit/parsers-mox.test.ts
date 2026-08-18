import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { moxParser } from '@/lib/parsers/mox'
import type { EmailMessage } from '@/lib/parsers/types'

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/emails', name), 'utf8')
}

function email(subject: string, fixtureName: string): EmailMessage {
  return {
    messageId: 'mox-1',
    from: 'Mox <notify@mox.com>',
    subject,
    body: fixture(fixtureName),
    receivedAt: new Date('2026-04-09T05:32:00Z'),
  }
}

describe('moxParser: brokerage trade (fund sell)', () => {
  const result = moxParser.parse(email('Sell executed', 'mox-trade-sell.txt'))

  it('reads the fund name, ISIN, quantity and side', () => {
    if (result?.fields.kind !== 'trade') throw new Error('expected a trade')
    expect(result.fields.side).toBe('sell')
    expect(result.fields.symbol).toBe('Allianz Yield Plus')
    expect(result.fields.isin).toBe('HK0000947546')
    expect(result.fields.quantity).toBe('400.0000')
    expect(result.fields.instrumentKind).toBe('mutual_fund')
  })

  it('uses the stated total rather than computing one', () => {
    if (result?.fields.kind !== 'trade') throw new Error('expected a trade')
    expect(result.fields.currency).toBe('HKD')
    expect(result.fields.amountMinor).toBe(450_216n)
  })
})

describe('moxParser: outgoing transfer', () => {
  const result = moxParser.parse(email('Money transfer successful', 'mox-transfer.txt'))

  it('is a transfer, sourced from the Mox account', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.amountMinor).toBe(440_000n)
    expect(result.fields.currency).toBe('HKD')
    expect(result.fields.accountRole).toBe('source')
  })

  it('carries the payee label forward — "ZA P (...)" names an institution', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.counterpartyLabel).toBe('ZA P (123-456*********)')
  })

  it('parses the day-month-name timestamp', () => {
    if (result?.fields.kind !== 'transfer') throw new Error('expected a transfer')
    expect(result.fields.occurredAt?.toISOString()).toBe('2026-04-15T05:28:00.000Z')
  })
})

describe('moxParser: sender scoping', () => {
  it('only matches Mox mail', () => {
    expect(
      moxParser.matches({ messageId: 'x', from: 'HSBC@notification.hsbc.com.hk', subject: '', body: '', receivedAt: new Date() }),
    ).toBe(false)
  })

  it('declines mail it does not recognise the shape of', () => {
    expect(
      moxParser.parse({
        messageId: 'x',
        from: 'notify@mox.com',
        subject: 'Welcome to Mox',
        body: 'Thanks for joining Mox Bank.',
        receivedAt: new Date(),
      }),
    ).toBeNull()
  })
})
