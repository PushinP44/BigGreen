import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { AccountSnapshot, CategorySnapshot, EntrySnapshot } from '@/lib/domain/balances'
import {
  DEFAULT_SETTINGS,
  evaluate,
  evaluatePayment,
  safetyTerms,
  VERDICT_SEVERITY,
  type SafetyInput,
  type SafetySettings,
} from '@/lib/domain/safety'

const NOW = new Date('2026-08-11T04:00:00Z') // 12:00 HKT

function account(id: string, overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    id,
    kind: 'bank',
    currency: 'HKD',
    isLiquid: true,
    isOwn: true,
    openingBalanceMinor: 0n,
    ...overrides,
  }
}

const bank = account('bank')
const card = account('card', { kind: 'credit_card', isLiquid: false })
const broker = account('broker', { kind: 'brokerage', isLiquid: false })
const expenses = account('expenses', { kind: 'expense', isLiquid: false, isOwn: false })
const accounts = [bank, card, broker, expenses]

const categories: CategorySnapshot[] = [
  { id: 'cat-food', name: 'Food', isDiscretionary: true },
  { id: 'cat-rent', name: 'Rent', isDiscretionary: false },
]

let seq = 0
function txn(
  legs: Array<[string, bigint]>,
  overrides: Partial<EntrySnapshot> = {},
): EntrySnapshot[] {
  seq += 1
  const transactionId = `txn-${seq}`
  return legs.map(([accountId, amountHkdMinor]) => ({
    transactionId,
    accountId,
    amountMinor: amountHkdMinor,
    currency: 'HKD' as const,
    amountHkdMinor,
    occurredAt: NOW,
    status: 'posted' as const,
    categoryId: null,
    isFxResidual: false,
    ...overrides,
  }))
}

function input(entries: EntrySnapshot[], settings: SafetySettings = DEFAULT_SETTINGS): SafetyInput {
  return { accounts, entries, categories, settings, now: NOW }
}

/** 50,000 HKD in the bank. */
const funded = txn([
  ['bank', 5_000_000n],
  ['expenses', -5_000_000n],
])

describe('terms', () => {
  it('computes available as liquid minus committed minus floor', () => {
    const terms = safetyTerms(input(funded))
    expect(terms.liquidHkdMinor).toBe(5_000_000n)
    expect(terms.committedHkdMinor).toBe(0n)
    expect(terms.floorHkdMinor).toBe(1_000_000n)
    expect(terms.availableHkdMinor).toBe(4_000_000n)
  })

  it('excludes non-liquid and non-owned accounts from liquid', () => {
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['broker', 9_000_000n],
          ['expenses', -9_000_000n],
        ]),
      ]),
    )
    expect(terms.liquidHkdMinor).toBe(5_000_000n)
  })

  it('counts a credit-card balance as committed, in full', () => {
    // Deliberately conservative (PLAN §5). It may understate `available`; it
    // must never overstate it.
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['card', -300_000n],
          ['expenses', 300_000n],
        ]),
      ]),
    )
    expect(terms.committedHkdMinor).toBe(300_000n)
    expect(terms.availableHkdMinor).toBe(3_700_000n)
  })

  it('counts scheduled external outflows inside the horizon', () => {
    const inTwoWeeks = new Date('2026-08-25T04:00:00Z')
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['bank', -800_000n],
            ['expenses', 800_000n],
          ],
          { status: 'scheduled', occurredAt: inTwoWeeks },
        ),
      ]),
    )
    expect(terms.committedHkdMinor).toBe(800_000n)
    expect(terms.availableHkdMinor).toBe(3_200_000n)
  })

  it('ignores scheduled outflows beyond the horizon', () => {
    const inSixtyDays = new Date('2026-10-10T04:00:00Z')
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['bank', -800_000n],
            ['expenses', 800_000n],
          ],
          { status: 'scheduled', occurredAt: inSixtyDays },
        ),
      ]),
    )
    expect(terms.committedHkdMinor).toBe(0n)
  })

  it('does not double-count a scheduled credit-card payment', () => {
    // The card balance is already committed. A scheduled transfer that settles
    // it is money moving between accounts you own, and counting it again would
    // make you look 3,000 poorer than you are.
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['card', -300_000n],
          ['expenses', 300_000n],
        ]),
        ...txn(
          [
            ['bank', -300_000n],
            ['card', 300_000n],
          ],
          { status: 'scheduled', occurredAt: new Date('2026-08-20T04:00:00Z') },
        ),
      ]),
    )
    expect(terms.committedHkdMinor).toBe(300_000n)
  })

  it('does not let scheduled entries move your balance', () => {
    // A bill you have not paid is a commitment, not a withdrawal.
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['bank', -800_000n],
            ['expenses', 800_000n],
          ],
          { status: 'scheduled', occurredAt: new Date('2026-08-25T04:00:00Z') },
        ),
      ]),
    )
    expect(terms.liquidHkdMinor).toBe(5_000_000n)
  })
})

describe('verdict', () => {
  const terms = () => safetyTerms(input(funded))

  it('is SAFE for a payment well inside available', () => {
    const result = evaluatePayment(terms(), {
      amountHkdMinor: 10_000n,
      isDiscretionary: false,
    })
    expect(result.verdict).toBe('SAFE')
    expect(result.remainingHkdMinor).toBe(3_990_000n)
    expect(result.reason).toMatch(/Leaves HK\$39,900\.00/)
  })

  it('is UNSAFE when it breaches the floor', () => {
    const result = evaluatePayment(terms(), {
      amountHkdMinor: 4_500_000n,
      isDiscretionary: false,
    })
    expect(result.verdict).toBe('UNSAFE')
    expect(result.shortfallHkdMinor).toBe(500_000n)
    // The reason names the numbers, not just the outcome.
    expect(result.reason).toMatch(/HK\$5,000\.00 more than you have available/)
    expect(result.reason).toMatch(/HK\$10,000\.00 floor/)
  })

  it('is exactly SAFE at the boundary', () => {
    expect(
      evaluatePayment(terms(), { amountHkdMinor: 4_000_000n, isDiscretionary: false }).verdict,
    ).toBe('SAFE')
    expect(
      evaluatePayment(terms(), { amountHkdMinor: 4_000_001n, isDiscretionary: false }).verdict,
    ).toBe('UNSAFE')
  })

  it('is CAUTION when affordable but over the discretionary budget', () => {
    const spent = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['bank', -550_000n],
            ['expenses', 550_000n],
          ],
          { categoryId: 'cat-food' },
        ),
      ]),
    )

    const result = evaluatePayment(spent, { amountHkdMinor: 100_000n, isDiscretionary: true })
    expect(result.verdict).toBe('CAUTION')
    expect(result.reason).toMatch(/HK\$500\.00 over/)
  })

  it('stays SAFE over budget when the category is not discretionary', () => {
    // Rent does not become unwise because you have eaten out a lot.
    const spent = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['bank', -700_000n],
            ['expenses', 700_000n],
          ],
          { categoryId: 'cat-food' },
        ),
      ]),
    )
    expect(
      evaluatePayment(spent, { amountHkdMinor: 100_000n, isDiscretionary: false }).verdict,
    ).toBe('SAFE')
  })

  it('reports being already below the floor plainly', () => {
    const broke = safetyTerms(
      input(
        txn([
          ['bank', 500_000n],
          ['expenses', -500_000n],
        ]),
      ),
    )
    expect(broke.availableHkdMinor).toBe(-500_000n)

    const result = evaluatePayment(broke, { amountHkdMinor: 100n, isDiscretionary: false })
    expect(result.verdict).toBe('UNSAFE')
    expect(result.reason).toMatch(/already HK\$5,000\.00 below your floor/)
  })

  it('UNSAFE beats CAUTION when both apply', () => {
    const spent = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['bank', -700_000n],
            ['expenses', 700_000n],
          ],
          { categoryId: 'cat-food' },
        ),
      ]),
    )
    // Unaffordable AND over budget: being broke is the more important fact.
    expect(
      evaluatePayment(spent, { amountHkdMinor: 9_000_000n, isDiscretionary: true }).verdict,
    ).toBe('UNSAFE')
  })
})

describe('monotonicity (PLAN §5)', () => {
  it('never moves the verdict toward safety as the amount grows', () => {
    // The property that makes the rule trustworthy: spending more can never
    // make a payment safer. Anything that violates this is a rule with a hole.
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['bank', -400_000n],
            ['expenses', 400_000n],
          ],
          { categoryId: 'cat-food' },
        ),
      ]),
    )

    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.boolean(),
        (a, b, isDiscretionary) => {
          const [smaller, larger] = a <= b ? [a, b] : [b, a]

          const low = evaluatePayment(terms, { amountHkdMinor: smaller, isDiscretionary })
          const high = evaluatePayment(terms, { amountHkdMinor: larger, isDiscretionary })

          expect(VERDICT_SEVERITY[high.verdict]).toBeGreaterThanOrEqual(
            VERDICT_SEVERITY[low.verdict],
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  it('always leaves less remaining as the amount grows', () => {
    const terms = safetyTerms(input(funded))
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10_000_000n }), (amount) => {
        const result = evaluatePayment(terms, { amountHkdMinor: amount, isDiscretionary: false })
        expect(result.remainingHkdMinor).toBe(terms.availableHkdMinor - amount)
      }),
    )
  })

  it('is deterministic — same input, same verdict', () => {
    const first = evaluate(input(funded), { amountHkdMinor: 123_456n, isDiscretionary: true })
    const second = evaluate(input(funded), { amountHkdMinor: 123_456n, isDiscretionary: true })
    expect(first).toEqual(second)
  })
})

describe('settings', () => {
  it('respects a different floor and budget', () => {
    const custom: SafetySettings = {
      emergencyFloorHkdMinor: 2_000_000n,
      discretionaryBudgetHkdMinor: 300_000n,
      horizonDays: 7,
    }
    const terms = safetyTerms(input(funded, custom))
    expect(terms.availableHkdMinor).toBe(3_000_000n)
    expect(terms.discretionaryBudgetHkdMinor).toBe(300_000n)
  })

  it('shrinks the committed window with a shorter horizon', () => {
    const inTwoWeeks = new Date('2026-08-25T04:00:00Z')
    const entries = [
      ...funded,
      ...txn(
        [
          ['bank', -800_000n],
          ['expenses', 800_000n],
        ],
        { status: 'scheduled', occurredAt: inTwoWeeks },
      ),
    ]

    expect(safetyTerms(input(entries)).committedHkdMinor).toBe(800_000n)
    expect(
      safetyTerms(input(entries, { ...DEFAULT_SETTINGS, horizonDays: 7 })).committedHkdMinor,
    ).toBe(0n)
  })
})
