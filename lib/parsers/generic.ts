/**
 * Generic bank-alert parser.
 *
 * Written before any real sample was available, so it deliberately extracts
 * only the things that are near-universal in HK bank alerts — an amount with a
 * currency, sometimes a card's last four digits, sometimes a merchant — and
 * scores itself honestly about the rest.
 *
 * It exists so the pipeline is useful on day one rather than blocked on
 * fixtures. As real emails arrive, per-sender parsers in `registry.ts` take
 * priority over this one and can be far more confident, because they know the
 * layout instead of inferring it.
 *
 * Pure: no I/O, no clock — `receivedAt` comes in with the message.
 */

import { isCurrency, parseAmountInput, type Currency } from '@/lib/domain/money'
import type { EmailMessage, ParseResult, Parser } from './types'

/**
 * Currency written before the amount (`HKD 1,234.50`, `HK$1,234.50`) or after
 * it (`1,234.50 HKD`). Both are common and the two forms need different
 * capture groups, so they are matched separately rather than with one clever
 * pattern nobody can debug later.
 */
const SYMBOLS: ReadonlyArray<{ token: string; currency: Currency }> = [
  { token: 'HKD', currency: 'HKD' },
  { token: 'HK\\$', currency: 'HKD' },
  { token: 'USD', currency: 'USD' },
  { token: 'US\\$', currency: 'USD' },
  { token: 'THB', currency: 'THB' },
  { token: '฿', currency: 'THB' },
  { token: 'BAHT', currency: 'THB' },
]

/**
 * The trailing lookahead is load-bearing.
 *
 * Without it, `HKD 1.2345` matches `1.23` and silently records HK$1.23 —
 * dropping digits off a real amount, which is the precise failure the rest of
 * this codebase exists to prevent. Refusing to match is correct: an amount we
 * cannot represent exactly should reach the review queue as unparsed, not as a
 * confident wrong number.
 *
 * `(?!\.\d)` rather than `(?!\.)` so a sentence-ending full stop is still fine.
 */
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?!\d)(?!\.\d)`

interface AmountHit {
  readonly amountMinor: bigint
  readonly currency: Currency
  readonly index: number
}

function findAmounts(text: string): AmountHit[] {
  const hits: AmountHit[] = []

  for (const { token, currency } of SYMBOLS) {
    for (const pattern of [
      new RegExp(`${token}\\s*${AMOUNT}`, 'gi'),
      new RegExp(`${AMOUNT}\\s*${token}\\b`, 'gi'),
    ]) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[1]
        if (raw === undefined) continue
        try {
          hits.push({
            amountMinor: parseAmountInput(raw, currency).amountMinor,
            currency,
            index: match.index ?? 0,
          })
        } catch {
          // More decimals than the currency has, or otherwise unparseable.
          // Skipping is correct: a number we cannot represent exactly is not a
          // number we should record.
        }
      }
    }
  }

  return hits.sort((a, b) => a.index - b.index)
}

const LAST4 = /(?:card|a\/c|account)[^\ndigits]{0,40}?(?:ending|ending in|no\.?|\*+|x+)\s*(\d{4})\b/i
const LAST4_MASKED = /(?:\*{2,}|x{2,}|•{2,})\s*(\d{4})\b/i

function findLast4(text: string): string | null {
  return LAST4.exec(text)?.[1] ?? LAST4_MASKED.exec(text)?.[1] ?? null
}

/**
 * Merchant, when the message labels it. Only trusted from an explicit label —
 * guessing at a line of prose produces a merchant like "Dear Customer", which
 * is worse than admitting we do not know.
 */
/**
 * Both patterns are non-greedy and stop at a following clause.
 *
 * A greedy capture runs to the end of the line and yields merchants like
 * "PARK N SHOP was made with card ending 4321" — which is not a merchant, and
 * is worse than admitting we do not know one.
 */
const MERCHANT_STOP = String.raw`(?=\s+(?:on|was|were|using|with|for|from|at)\s|\s*[.,;:]|\s*$)`
const MERCHANT = new RegExp(
  String.raw`(?:at|merchant|payee|to)\s*[:\-]\s*([^\n\r]{2,60}?)${MERCHANT_STOP}`,
  'i',
)
const MERCHANT_AT = new RegExp(
  String.raw`\bat\s+([A-Z0-9][A-Za-z0-9 &'._-]{1,40}?)${MERCHANT_STOP}`,
)

function findMerchant(text: string): string | null {
  const labelled = MERCHANT.exec(text)?.[1]?.trim()
  if (labelled) return clean(labelled)
  const inline = MERCHANT_AT.exec(text)?.[1]?.trim()
  return inline ? clean(inline) : null
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim().slice(0, 60)
}

/**
 * A refund or credit rather than a charge. Deliberately conservative: getting
 * the sign wrong turns a HK$500 refund into a HK$500 charge, a HK$1,000 error,
 * so anything ambiguous stays a spend and loses confidence for it.
 */
const CREDIT_HINTS = /\b(refund|reversal|credited|received|deposit|repayment|cash ?back)\b/i
// "transaction" is deliberately absent: it describes a charge and a refund
// equally well, and nearly every alert subject contains it. Counting it as a
// debit hint made every refund read as ambiguous and lose its sign.
const DEBIT_HINTS = /\b(purchase|payment|spent|charged|debited|withdrawal)\b/i

export const genericParser: Parser = {
  id: 'generic',

  matches(message: EmailMessage): boolean {
    return findAmounts(`${message.subject}\n${message.body}`).length > 0
  },

  parse(message: EmailMessage): ParseResult | null {
    const text = `${message.subject}\n${message.body}`
    const amounts = findAmounts(text)

    // No amount means there is nothing to post and nothing to review. Returning
    // null rather than a low score keeps statements and marketing mail out of
    // the queue entirely.
    if (amounts.length === 0) return null

    const notes: string[] = []
    const primary = amounts[0]!

    // Alerts routinely quote a balance or a limit alongside the charge. When
    // several amounts appear we cannot tell which is the transaction, so the
    // first is used and confidence drops to force a human look.
    const ambiguousAmount = amounts.length > 1
    if (ambiguousAmount) {
      notes.push(`${amounts.length} amounts found; used the first — check it is the charge`)
    }

    const isCredit = CREDIT_HINTS.test(text)
    const isDebit = DEBIT_HINTS.test(text)
    if (isCredit && isDebit) {
      notes.push('message reads as both a charge and a credit; assumed a charge')
    } else if (!isCredit && !isDebit) {
      notes.push('no wording identifying this as a charge or a credit')
    }

    const merchant = findMerchant(text)
    if (!merchant) notes.push('no merchant found')

    const last4 = findLast4(text)
    if (!last4) notes.push('no card or account number found')

    // Confidence is built from what was found, weighted by what actually
    // matters for posting unreviewed. An amount and currency are most of it;
    // merchant and card number mostly help you recognise the row later.
    let confidence = 0.55 // an unambiguous amount in a known currency
    if (!ambiguousAmount) confidence += 0.15
    if (isCredit !== isDebit) confidence += 0.12
    if (merchant) confidence += 0.1
    if (last4) confidence += 0.08

    return {
      parserId: 'generic',
      confidence: Math.min(1, Math.round(confidence * 100) / 100),
      fields: {
        amountMinor: primary.amountMinor,
        currency: primary.currency,
        direction: isCredit && !isDebit ? 'income' : 'spend',
        merchant,
        accountLast4: last4,
        occurredAt: null,
        description: merchant ?? clean(message.subject) ?? 'Bank alert',
      },
      notes,
    }
  },
}

export { findAmounts, findLast4, findMerchant, isCurrency }
