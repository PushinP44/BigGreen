import { describe, expect, it } from 'vitest'
import { genericParser } from '@/lib/parsers/generic'
import { institutionFromText, institutionOf, parseEmail } from '@/lib/parsers/registry'
import type { EmailMessage, ParseResult } from '@/lib/parsers/types'

function email(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    messageId: 'msg-1',
    from: 'alerts@hsbc.com.hk',
    subject: 'Transaction alert',
    body: '',
    receivedAt: new Date('2026-08-12T04:00:00Z'),
    ...overrides,
  }
}

/** genericParser only ever emits `kind: 'transaction'` — this just gives the tests below their fields back narrowed. */
function spendFields(result: ParseResult | null) {
  if (!result || result.fields.kind !== 'transaction') return undefined
  return result.fields
}

describe('amount extraction', () => {
  it('reads a currency written before the amount', () => {
    const result = genericParser.parse(
      email({ body: 'A purchase of HKD 1,234.50 was made on your card.' }),
    )
    expect(result?.fields.amountMinor).toBe(123450n)
    expect(result?.fields.currency).toBe('HKD')
  })

  it('reads a symbol written before the amount', () => {
    const result = genericParser.parse(email({ body: 'Charged HK$248.50 at a merchant.' }))
    expect(result?.fields.amountMinor).toBe(24850n)
  })

  it('reads a currency written after the amount', () => {
    const result = genericParser.parse(email({ body: 'Amount: 450.00 THB was debited.' }))
    expect(result?.fields.amountMinor).toBe(45000n)
    expect(result?.fields.currency).toBe('THB')
  })

  it('reads baht by symbol', () => {
    expect(genericParser.parse(email({ body: 'Spent ฿1,200 today' }))?.fields.currency).toBe('THB')
  })

  it('handles an amount with no decimals', () => {
    expect(genericParser.parse(email({ body: 'USD 100 charged' }))?.fields.amountMinor).toBe(10000n)
  })

  it('returns null when there is no amount at all', () => {
    // A statement notice or marketing mail. Returning null rather than a low
    // score is what keeps them out of the review queue entirely.
    expect(genericParser.parse(email({ body: 'Your e-statement is ready to view.' }))).toBeNull()
  })

  it('skips an amount with more precision than the currency has', () => {
    // A number we cannot represent exactly is not a number to record.
    expect(genericParser.parse(email({ body: 'HKD 1.2345 something' }))).toBeNull()
  })
})

describe('confidence', () => {
  it('is high for a complete, unambiguous alert', () => {
    const result = genericParser.parse(
      email({
        subject: 'Card transaction alert',
        body: 'A purchase of HKD 248.50 at: PARK N SHOP was made with card ending 4321.',
      }),
    )
    expect(result!.confidence).toBeGreaterThanOrEqual(0.9)
    expect(result!.notes).toEqual([])
  })

  it('drops when several amounts appear, because the charge is ambiguous', () => {
    // Alerts routinely quote a balance or limit alongside the charge, and
    // picking the wrong one silently records the wrong transaction.
    const result = genericParser.parse(
      email({
        body: 'Purchase of HKD 248.50 at: WATSONS. Available balance HKD 12,340.00.',
      }),
    )
    expect(result!.confidence).toBeLessThan(0.9)
    expect(result!.notes.join(' ')).toMatch(/2 amounts found/)
  })

  it('drops when nothing says whether it is a charge or a credit', () => {
    const result = genericParser.parse(email({ body: 'HKD 500.00 — PARK N SHOP' }))
    expect(result!.notes.join(' ')).toMatch(/charge or a credit/)
    expect(result!.confidence).toBeLessThan(0.9)
  })

  it('never exceeds 1', () => {
    const result = genericParser.parse(
      email({
        body: 'Purchase charged: HKD 248.50 at: PARK N SHOP with card ending 4321',
      }),
    )
    expect(result!.confidence).toBeLessThanOrEqual(1)
  })
})

describe('direction', () => {
  it('reads a refund as income', () => {
    const result = genericParser.parse(email({ body: 'A refund of HKD 120.00 has been credited.' }))
    expect(spendFields(result)?.direction).toBe('income')
  })

  it('reads a purchase as a spend', () => {
    const result = genericParser.parse(email({ body: 'Purchase of HKD 120.00 was charged.' }))
    expect(spendFields(result)?.direction).toBe('spend')
  })

  it('assumes a charge when the wording says both, and says so', () => {
    // Getting the sign wrong turns a HK$500 refund into a HK$500 charge — a
    // HK$1,000 error — so ambiguity stays a spend and loses confidence.
    const result = genericParser.parse(
      email({ body: 'Your refund purchase of HKD 500.00 was charged and credited.' }),
    )
    expect(spendFields(result)?.direction).toBe('spend')
    expect(result!.notes.join(' ')).toMatch(/both a charge and a credit/)
  })
})

describe('merchant and card', () => {
  it('takes a labelled merchant', () => {
    expect(
      spendFields(genericParser.parse(email({ body: 'HKD 100.00 merchant: CITY SUPER LTD on 12 Aug' })))
        ?.merchant,
    ).toBe('CITY SUPER LTD')
  })

  it('takes an inline "at MERCHANT"', () => {
    expect(
      spendFields(genericParser.parse(email({ body: 'Purchase HKD 100.00 at PARK N SHOP on 12 Aug' })))
        ?.merchant,
    ).toBe('PARK N SHOP')
  })

  it('admits it does not know rather than inventing one', () => {
    const result = genericParser.parse(email({ body: 'Purchase of HKD 100.00 was charged.' }))
    expect(spendFields(result)?.merchant).toBeNull()
    expect(result!.notes.join(' ')).toMatch(/no merchant/)
  })

  it('reads a card ending', () => {
    expect(
      genericParser.parse(email({ body: 'HKD 100.00 charged to card ending 4321' }))?.fields
        .accountLast4,
    ).toBe('4321')
  })

  it('reads a masked card number', () => {
    expect(
      genericParser.parse(email({ body: 'HKD 100.00 on ****5678' }))?.fields.accountLast4,
    ).toBe('5678')
  })

  it('reads the leading digits of an account number shown front-masked', () => {
    expect(
      genericParser.parse(email({ body: 'HKD 100.00 from A/C 1234******' }))?.fields.accountLast4,
    ).toBe('1234')
  })

  it('prefers a labelled card ending over a leading-digit mask elsewhere in the message', () => {
    const result = genericParser.parse(
      email({ body: 'HKD 100.00 charged to card ending 4321. Linked A/C 9876******.' }),
    )
    expect(result?.fields.accountLast4).toBe('4321')
  })
})

describe('registry', () => {
  it('identifies the institution from the sender', () => {
    expect(institutionOf(email({ from: 'alerts@hsbc.com.hk' }))).toBe('hsbc')
    expect(institutionOf(email({ from: 'no-reply@mox.com' }))).toBe('mox')
    expect(institutionOf(email({ from: 'notice@za.group' }))).toBe('za')
    expect(institutionOf(email({ from: 'service@krungthai.com' }))).toBe('ktb')
    expect(institutionOf(email({ from: 'someone@example.com' }))).toBeNull()
  })

  it('falls through to the generic parser and tags the institution', () => {
    const result = parseEmail(
      email({ from: 'alerts@hsbc.com.hk', body: 'Purchase of HKD 248.50 at PARK N SHOP' }),
    )
    expect(result?.parserId).toBe('generic')
    expect(result?.institution).toBe('hsbc')
  })

  it('returns null for mail nothing can read', () => {
    // Statements and notices never reach the review queue.
    expect(parseEmail(email({ body: 'Your monthly e-statement is now available.' }))).toBeNull()
  })

  it('prefers a per-sender parser over generic when it recognises the shape', () => {
    const result = parseEmail(
      email({
        from: 'HSBC@notification.hsbc.com.hk',
        subject: 'HSBC Credit Card Transaction Notification',
        body: [
          'We have recorded the following card-not-present* transaction:',
          'Credit card number',
          'Ending with 4321',
          'Merchant',
          'APPLE.COM/BILL',
          'Amount',
          'HKD18.00',
        ].join('\n'),
      }),
    )
    expect(result?.parserId).toBe('hsbc-cnp-transaction')
  })

  it('institutionFromText recognises an institution named in free text', () => {
    expect(institutionFromText('ZA P (123-456*********)')).toBe('za')
    expect(institutionFromText('HSBC')).toBe('hsbc')
    expect(institutionFromText('Mox savings')).toBe('mox')
  })

  it('institutionFromText refuses to guess when nothing names an institution', () => {
    expect(institutionFromText('+852-1234***5')).toBeNull()
    expect(institutionFromText('98XXXX123')).toBeNull()
  })
})
