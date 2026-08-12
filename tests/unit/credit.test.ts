import { describe, expect, it } from 'vitest'
import {
  availableCreditMinor,
  billedMinor,
  cardPosition,
  CreditError,
  DEFAULT_CARD_TERMS,
  dueDateAfter,
  estimatedMonthlyInterestMinor,
  minimumPaymentMinor,
  owedMinor,
  statementCycle,
  unbilledMinor,
  type CreditCardTerms,
} from '@/lib/domain/credit'
import { toLocalDate } from '@/lib/domain/clock'
import type { EntrySnapshot } from '@/lib/domain/balances'

const CARD = 'card'

/** Statement closes on the 25th, payment due on the 15th of the next month. */
const terms: CreditCardTerms = {
  ...DEFAULT_CARD_TERMS,
  statementDay: 25,
  paymentDueDay: 15,
  creditLimitMinor: 5_000_000n, // HK$50,000
  aprBps: 3600, // 36%
  minPaymentPctBps: 100, // 1%
  minPaymentFloorMinor: 5_000n, // HK$50
}

let seq = 0
function spend(amountMinor: bigint, occurredAt: string, accountId = CARD): EntrySnapshot {
  seq += 1
  return {
    transactionId: `txn-${seq}`,
    accountId,
    // Spending on a card credits the liability, so the ledger amount is negative.
    amountMinor: -amountMinor,
    currency: 'HKD',
    amountHkdMinor: -amountMinor,
    occurredAt: new Date(occurredAt),
    status: 'posted',
    categoryId: null,
    isFxResidual: false,
  }
}

describe('statement cycle', () => {
  it('finds the closed statement when today is after the statement day', () => {
    // 2026-08-30 HKT — the 25th has passed, so August is closed.
    const cycle = statementCycle(new Date('2026-08-30T04:00:00Z'), terms)
    expect(toLocalDate(cycle.closedAt)).toBe('2026-08-25')
    expect(toLocalDate(cycle.billedFrom)).toBe('2026-07-25')
    expect(toLocalDate(cycle.nextCloseAt)).toBe('2026-09-25')
  })

  it('reaches back a month when today is before the statement day', () => {
    // 2026-08-10 — the August statement has not closed yet, so July's is current.
    const cycle = statementCycle(new Date('2026-08-10T04:00:00Z'), terms)
    expect(toLocalDate(cycle.closedAt)).toBe('2026-07-25')
    expect(toLocalDate(cycle.nextCloseAt)).toBe('2026-08-25')
  })

  it('treats the statement day itself as closed', () => {
    const cycle = statementCycle(new Date('2026-08-24T16:30:00Z'), terms) // 00:30 HKT on the 25th
    expect(toLocalDate(cycle.closedAt)).toBe('2026-08-25')
  })

  it('rolls a due day earlier than the statement day into the next month', () => {
    // Closes 25 Aug, due on the 15th — that has to mean 15 September, not a
    // date ten days before the statement it pays for.
    const cycle = statementCycle(new Date('2026-08-30T04:00:00Z'), terms)
    expect(toLocalDate(cycle.dueAt)).toBe('2026-09-15')
  })

  it('keeps a due day later than the statement day in the same month', () => {
    const sameMonth = { ...terms, statementDay: 5, paymentDueDay: 26 }
    const cycle = statementCycle(new Date('2026-08-10T04:00:00Z'), sameMonth)
    expect(toLocalDate(cycle.closedAt)).toBe('2026-08-05')
    expect(toLocalDate(cycle.dueAt)).toBe('2026-08-26')
  })

  it('clamps a 31st statement day to short months', () => {
    // Otherwise Date arithmetic rolls 31 February into 3 March and every cycle
    // boundary after it is wrong.
    const endOfMonth = { ...terms, statementDay: 31, paymentDueDay: 20 }
    const cycle = statementCycle(new Date('2026-03-01T04:00:00Z'), endOfMonth)
    expect(toLocalDate(cycle.closedAt)).toBe('2026-02-28')
  })

  it('handles a February statement day in a leap year', () => {
    const endOfMonth = { ...terms, statementDay: 31, paymentDueDay: 20 }
    const cycle = statementCycle(new Date('2024-03-05T04:00:00Z'), endOfMonth)
    expect(toLocalDate(cycle.closedAt)).toBe('2024-02-29')
  })

  it('crosses the year boundary', () => {
    const cycle = statementCycle(new Date('2027-01-10T04:00:00Z'), terms)
    expect(toLocalDate(cycle.closedAt)).toBe('2026-12-25')
    expect(toLocalDate(cycle.dueAt)).toBe('2027-01-15')
  })

  it('rejects a nonsense statement or due day', () => {
    expect(() => statementCycle(new Date(), { ...terms, statementDay: 0 })).toThrow(CreditError)
    expect(() => statementCycle(new Date(), { ...terms, statementDay: 32 })).toThrow(CreditError)
    expect(() => statementCycle(new Date(), { ...terms, paymentDueDay: 1.5 })).toThrow(CreditError)
  })

  it('computes a due date from an arbitrary close', () => {
    expect(toLocalDate(dueDateAfter(new Date('2026-08-24T16:00:00Z'), 15))).toBe('2026-09-15')
  })
})

describe('billed vs un-billed', () => {
  const now = new Date('2026-08-30T04:00:00Z') // after the 25th
  const cycle = statementCycle(now, terms)

  const entries = [
    spend(200_000n, '2026-08-01T04:00:00Z'), // billed
    spend(150_000n, '2026-08-20T04:00:00Z'), // billed
    spend(80_000n, '2026-08-27T04:00:00Z'), // after close — un-billed
    spend(50_000n, '2026-08-29T04:00:00Z'), // un-billed
  ]

  it('sums everything you owe', () => {
    expect(owedMinor(entries, CARD)).toBe(480_000n)
  })

  it('bills only what happened before the statement closed', () => {
    expect(billedMinor(entries, CARD, cycle)).toBe(350_000n)
  })

  it('leaves the rest for next cycle', () => {
    // Reported separately so the dashboard can say "you owe X, of which Y is
    // due on the 15th" — rolling them together is how people get surprised.
    expect(unbilledMinor(entries, CARD, cycle)).toBe(130_000n)
  })

  it('ignores entries on other accounts', () => {
    const withOther = [...entries, spend(999_999n, '2026-08-02T04:00:00Z', 'bank')]
    expect(owedMinor(withOther, CARD)).toBe(480_000n)
  })

  it('ignores scheduled and pending entries', () => {
    const withScheduled: EntrySnapshot[] = [
      ...entries,
      { ...spend(900_000n, '2026-08-02T04:00:00Z'), status: 'scheduled' },
      { ...spend(700_000n, '2026-08-03T04:00:00Z'), status: 'pending' },
    ]
    expect(owedMinor(withScheduled, CARD)).toBe(480_000n)
  })

  it('reports zero when the card is paid off or in credit', () => {
    const paid = [spend(200_000n, '2026-08-01T04:00:00Z'), spend(-250_000n, '2026-08-05T04:00:00Z')]
    expect(owedMinor(paid, CARD)).toBe(0n)
  })
})

describe('minimum payment', () => {
  it('takes the percentage when it exceeds the floor', () => {
    // 1% of HK$50,000 = HK$500, well above the HK$50 floor.
    expect(minimumPaymentMinor(5_000_000n, terms)).toBe(50_000n)
  })

  it('takes the floor when the percentage is trivial', () => {
    // 1% of HK$1,000 = HK$10, below the HK$50 floor.
    expect(minimumPaymentMinor(100_000n, terms)).toBe(5_000n)
  })

  it('never asks for more than you owe', () => {
    // A HK$50 floor on a HK$12 balance is HK$12, not HK$50.
    expect(minimumPaymentMinor(1_200n, terms)).toBe(1_200n)
  })

  it('is zero on a cleared card', () => {
    expect(minimumPaymentMinor(0n, terms)).toBe(0n)
    expect(minimumPaymentMinor(-5_000n, terms)).toBe(0n)
  })
})

describe('cost of carrying', () => {
  it('estimates monthly interest from the APR', () => {
    // HK$40,000 at 36% ≈ HK$1,200/month.
    expect(estimatedMonthlyInterestMinor(4_000_000n, 3600)).toBe(120_000n)
  })

  it('returns null when no APR has been recorded, rather than guessing', () => {
    expect(estimatedMonthlyInterestMinor(4_000_000n, null)).toBeNull()
    expect(estimatedMonthlyInterestMinor(4_000_000n, 0)).toBeNull()
  })

  it('is zero on a cleared card', () => {
    expect(estimatedMonthlyInterestMinor(0n, 3600)).toBe(0n)
  })

  it('reports remaining headroom, floored at zero', () => {
    expect(availableCreditMinor(5_000_000n, 1_200_000n)).toBe(3_800_000n)
    expect(availableCreditMinor(5_000_000n, 6_000_000n)).toBe(0n)
    expect(availableCreditMinor(null, 1_200_000n)).toBeNull()
  })
})

describe('cardPosition — what the safety rule consumes', () => {
  const now = new Date('2026-08-30T04:00:00Z')
  const carrying = [
    spend(4_000_000n, '2026-06-10T04:00:00Z'), // long-standing balance
    spend(150_000n, '2026-08-20T04:00:00Z'), // billed this cycle
    spend(80_000n, '2026-08-27T04:00:00Z'), // un-billed
  ]

  it('commits only the minimum payment for a revolver', () => {
    // The point of the whole module: treating a HK$42,300 carried balance as
    // due in the next 30 days would report nothing available, every day,
    // forever — and a rule that always says UNSAFE stops being read.
    const position = cardPosition(carrying, CARD, now, {
      terms,
      model: 'minimum_payment',
      horizonDays: 30,
    })

    expect(position.owedMinor).toBe(4_230_000n)
    expect(position.billedMinor).toBe(4_150_000n)
    expect(position.unbilledMinor).toBe(80_000n)
    expect(position.minimumPaymentMinor).toBe(41_500n) // 1% of billed
    expect(position.committedMinor).toBe(41_500n)
  })

  it('commits the whole balance under the full-balance model', () => {
    const position = cardPosition(carrying, CARD, now, {
      terms,
      model: 'full_balance',
      horizonDays: 30,
    })
    expect(position.committedMinor).toBe(4_230_000n)
  })

  it('commits nothing when the payment falls outside the horizon', () => {
    // Due 15 September; a 7-day horizon does not reach it.
    const position = cardPosition(carrying, CARD, now, {
      terms,
      model: 'minimum_payment',
      horizonDays: 7,
    })
    expect(position.dueWithinHorizon).toBe(false)
    expect(position.committedMinor).toBe(0n)
  })

  it('surfaces the cost of the balance rather than hiding it', () => {
    const position = cardPosition(carrying, CARD, now, {
      terms,
      model: 'minimum_payment',
      horizonDays: 30,
    })
    // HK$42,300 at 36% is about HK$1,269 a month — the number that makes
    // carrying the balance a visible choice.
    expect(position.estimatedMonthlyInterestMinor).toBe(126_900n)
    expect(position.availableCreditMinor).toBe(770_000n)
  })

  it('is harmless on a cleared card', () => {
    const position = cardPosition([], CARD, now, {
      terms,
      model: 'minimum_payment',
      horizonDays: 30,
    })
    expect(position.owedMinor).toBe(0n)
    expect(position.minimumPaymentMinor).toBe(0n)
    expect(position.committedMinor).toBe(0n)
    expect(position.estimatedMonthlyInterestMinor).toBe(0n)
  })

  it('never lets the gentler model make committed larger', () => {
    // minimum_payment must always be the more permissive of the two, so
    // switching models can only move `available` one way.
    const minimum = cardPosition(carrying, CARD, now, {
      terms,
      model: 'minimum_payment',
      horizonDays: 30,
    })
    const full = cardPosition(carrying, CARD, now, {
      terms,
      model: 'full_balance',
      horizonDays: 30,
    })
    expect(minimum.committedMinor).toBeLessThanOrEqual(full.committedMinor)
  })
})
