import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ktbParser } from '@/lib/parsers/ktb'
import type { EmailMessage } from '@/lib/parsers/types'

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/emails', name), 'utf8')
}

function email(subject: string, fixtureName: string): EmailMessage {
  return {
    messageId: 'ktb-1',
    from: 'Krungthai NEXT <noreply@krungthai.com>',
    subject,
    body: fixture(fixtureName),
    receivedAt: new Date('2026-08-10T04:10:00Z'),
  }
}

describe('ktbParser: PromptPay transfer', () => {
  const result = ktbParser.parse(email('แจ้งผลการโอนเงินพร้อมเพย์สำเร็จ', 'ktb-transfer.txt'))

  it('is recorded as a spend — the recipient is always a named third party', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    expect(result.fields.amountMinor).toBe(50_000n)
    expect(result.fields.currency).toBe('THB')
    expect(result.fields.direction).toBe('spend')
  })

  it('reads the recipient name as the merchant/description', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    expect(result.fields.merchant).toBe('นางสาว สมหญิง ใจงาม')
  })

  it('converts the Buddhist Era date to the Common Era, in Bangkok time', () => {
    if (result?.fields.kind !== 'transaction') throw new Error('expected a transaction')
    // 10/08/2569 11:10:24 (BE) = 2026-08-10 11:10:24 +07:00
    expect(result.fields.occurredAt?.toISOString()).toBe('2026-08-10T04:10:24.000Z')
  })

  it('is confident given the recipient is always named', () => {
    expect(result!.confidence).toBeGreaterThanOrEqual(0.9)
  })
})

describe('ktbParser: sender scoping', () => {
  it('only matches Krungthai mail', () => {
    expect(
      ktbParser.matches({ messageId: 'x', from: 'HSBC@notification.hsbc.com.hk', subject: '', body: '', receivedAt: new Date() }),
    ).toBe(false)
  })

  it('declines mail with no PromptPay signal', () => {
    expect(
      ktbParser.parse({
        messageId: 'x',
        from: 'noreply@krungthai.com',
        subject: 'Welcome',
        body: 'ยินดีต้อนรับสู่ Krungthai NEXT',
        receivedAt: new Date(),
      }),
    ).toBeNull()
  })
})
