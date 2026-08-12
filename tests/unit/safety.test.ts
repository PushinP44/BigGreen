import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { AccountSnapshot, CategorySnapshot, EntrySnapshot } from '@/lib/domain/balances'
import {
  DEFAULT_SETTINGS,
  evaluatePayment,
  poolTermsFor,
  safetyTerms,
  termsFromJson,
  termsToJson,
  VERDICT_SEVERITY,
  type SafetyInput,
  type SafetySettings,
} from '@/lib/domain/safety'
import type { Currency } from '@/lib/domain/money'

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

// Three pools, matching the real setup: HKD across HK banks, USD at ZA, THB at KTB.
const hsbc = account('hsbc')
const card = account('card', { kind: 'credit_card', isLiquid: false })
const zaUsd = account('za-usd', { currency: 'USD' })
const ktb = account('ktb', { currency: 'THB' })
const expenses = account('expenses', { kind: 'expense', isLiquid: false, isOwn: false })
const accounts = [hsbc, card, zaUsd, ktb, expenses]

const categories: CategorySnapshot[] = [
  { id: 'cat-food', name: 'Food', isDiscretionary: true },
  { id: 'cat-rent', name: 'Rent', isDiscretionary: false },
]

let seq = 0
function txn(
  legs: Array<[string, bigint, Currency?]>,
  overrides: Partial<EntrySnapshot> = {},
): EntrySnapshot[] {
  seq += 1
  const transactionId = `txn-${seq}`
  return legs.map(([accountId, amountMinor, currency = 'HKD']) => ({
    transactionId,
    accountId,
    amountMinor,
    currency,
    // Rates chosen so the arithmetic in the tests stays readable.
    amountHkdMinor:
      currency === 'HKD'
        ? amountMinor
        : currency === 'USD'
          ? amountMinor * 8n
          : amountMinor / 5n,
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

/** HK$50,000 at HSBC. */
const funded = txn([
  ['hsbc', 5_000_000n],
  ['expenses', -5_000_000n],
])

describe('per-currency pools (PLAN rev 4)', () => {
  it('keeps each currency in its own pool, in its own units', () => {
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['za-usd', 100_000n, 'USD'],
          ['expenses', -800_000n],
        ]),
        ...txn([
          ['ktb', 5_000_000n, 'THB'],
          ['expenses', -1_000_000n],
        ]),
      ]),
    )

    // Base currency first because that is where you live; the rest sorted so
    // the order never depends on what the database happened to return.
    expect(terms.pools.map((p) => p.currency)).toEqual(['HKD', 'THB', 'USD'])
    expect(poolTermsFor(terms, 'HKD')?.liquidMinor).toBe(5_000_000n)
    expect(poolTermsFor(terms, 'USD')?.liquidMinor).toBe(100_000n)
    expect(poolTermsFor(terms, 'THB')?.liquidMinor).toBe(5_000_000n)
  })

  it('never lets one pool subsidise another', () => {
    // The whole point of rev 4: baht in a Thai bank cannot buy lunch in Hong
    // Kong, so a large THB balance must not make an HKD payment look safe.
    const terms = safetyTerms(
      input(
        txn([
          ['ktb', 100_000_000n, 'THB'],
          ['expenses', -20_000_000n],
        ]),
      ),
    )

    const verdict = evaluatePayment(terms, {
      amountMinor: 10_000n,
      currency: 'HKD',
      amountHkdMinor: 10_000n,
      isDiscretionary: false,
    })
    expect(verdict?.verdict).toBe('UNSAFE')
  })

  it('judges a THB payment against the THB pool', () => {
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['ktb', 5_000_000n, 'THB'],
          ['expenses', -1_000_000n],
        ]),
      ]),
    )

    const verdict = evaluatePayment(terms, {
      amountMinor: 100_000n,
      currency: 'THB',
      amountHkdMinor: 20_000n,
      isDiscretionary: false,
    })
    expect(verdict?.verdict).toBe('SAFE')
    expect(verdict?.currency).toBe('THB')
    expect(verdict?.reason).toContain('฿')
  })

  it('gives an account you own a pool even at zero, so it is visible', () => {
    // Pools come from accounts, not from activity. A USD account you have not
    // used yet is still a pool worth showing at zero — otherwise it vanishes
    // from the dashboard exactly when you are wondering where it went.
    const terms = safetyTerms(input(funded))
    expect(poolTermsFor(terms, 'USD')?.liquidMinor).toBe(0n)
  })

  it('returns no verdict for a currency you hold no account in', () => {
    // Better to decline than to invent a pool and judge against nothing.
    const noThb = {
      ...input(funded),
      accounts: accounts.filter((a) => a.currency !== 'THB'),
    }
    const terms = safetyTerms(noThb)

    expect(poolTermsFor(terms, 'THB')).toBeUndefined()
    expect(
      evaluatePayment(terms, {
        amountMinor: 100n,
        currency: 'THB',
        amountHkdMinor: 20n,
        isDiscretionary: false,
      }),
    ).toBeNull()
  })
})

describe('runway floor', () => {
  it('derives the floor from days of cover, not a constant', () => {
    // Declared HK$8,000/month → 8,000 × 12 / 365 ≈ HK$263/day → 45 days ≈ HK$11,835.
    const hkd = poolTermsFor(safetyTerms(input(funded)), 'HKD')!

    expect(hkd.burnSource).toBe('declared')
    expect(hkd.dailyBurnMinor).toBe((800_000n * 12n) / 365n)
    expect(hkd.floorMinor).toBe(hkd.dailyBurnMinor * 45n)
    expect(hkd.availableMinor).toBe(5_000_000n - hkd.floorMinor)
  })

  it('moves the floor when the declared spend changes', () => {
    // A fixed cushion is a guess that goes stale in silence; this one tracks.
    const richer: SafetySettings = {
      ...DEFAULT_SETTINGS,
      pools: { ...DEFAULT_SETTINGS.pools, HKD: { floorDays: 45, declaredMonthlySpendMinor: 2_000_000n } },
    }
    const lean = poolTermsFor(safetyTerms(input(funded)), 'HKD')!
    const heavy = poolTermsFor(safetyTerms(input(funded, richer)), 'HKD')!

    expect(heavy.floorMinor).toBeGreaterThan(lean.floorMinor)
    expect(heavy.availableMinor).toBeLessThan(lean.availableMinor)
  })

  it('reports runway in days', () => {
    const hkd = poolTermsFor(safetyTerms(input(funded)), 'HKD')!
    // 50,000 / 263 per day ≈ 190 days.
    expect(hkd.runwayDays).toBeGreaterThan(180)
    expect(hkd.runwayDays).toBeLessThan(200)
  })

  it('gives pools with no declared spend no floor and no runway', () => {
    // USD is savings and THB is travel money; neither pretends to a cushion.
    const terms = safetyTerms(
      input(
        txn([
          ['za-usd', 100_000n, 'USD'],
          ['expenses', -800_000n],
        ]),
      ),
    )
    const usd = poolTermsFor(terms, 'USD')!

    expect(usd.floorMinor).toBe(0n)
    expect(usd.runwayDays).toBeNull()
    expect(usd.burnSource).toBe('none')
    // It still produces a verdict — just "would this overdraw you".
    expect(usd.availableMinor).toBe(100_000n)
  })

  it('says which burn rate it used', () => {
    expect(poolTermsFor(safetyTerms(input(funded)), 'HKD')?.burnSource).toBe('declared')
  })

  it('switches to the measured burn once there is enough history', () => {
    // A number derived from real spending beats a guess — but only once it
    // exists, which is why the declared figure bootstraps it.
    const old = new Date('2026-05-01T04:00:00Z') // >30 days before NOW
    const entries = [
      ...txn(
        [
          ['hsbc', 10_000_000n],
          ['expenses', -10_000_000n],
        ],
        { occurredAt: old },
      ),
      ...txn(
        [
          ['hsbc', -900_000n],
          ['expenses', 900_000n],
        ],
        { occurredAt: new Date('2026-07-15T04:00:00Z') },
      ),
    ]

    const hkd = poolTermsFor(safetyTerms(input(entries)), 'HKD')!
    expect(hkd.burnSource).toBe('measured')
    expect(hkd.dailyBurnMinor).toBeGreaterThan(0n)
  })

  it('falls back to declared when history exists but the pool has no spending', () => {
    // Zero measured burn is honest, not a signal to invent one.
    const old = new Date('2026-05-01T04:00:00Z')
    const entries = txn(
      [
        ['hsbc', 5_000_000n],
        ['expenses', -5_000_000n],
      ],
      { occurredAt: old },
    )
    expect(poolTermsFor(safetyTerms(input(entries)), 'HKD')?.burnSource).toBe('declared')
  })
})

describe('committed', () => {
  it('counts a credit-card balance in full', () => {
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['card', -300_000n],
          ['expenses', 300_000n],
        ]),
      ]),
    )
    expect(poolTermsFor(terms, 'HKD')?.committedMinor).toBe(300_000n)
  })

  it('counts scheduled external outflows inside the horizon', () => {
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['hsbc', -800_000n],
            ['expenses', 800_000n],
          ],
          { status: 'scheduled', occurredAt: new Date('2026-08-25T04:00:00Z') },
        ),
      ]),
    )
    expect(poolTermsFor(terms, 'HKD')?.committedMinor).toBe(800_000n)
  })

  it('ignores scheduled outflows beyond the horizon', () => {
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['hsbc', -800_000n],
            ['expenses', 800_000n],
          ],
          { status: 'scheduled', occurredAt: new Date('2026-10-10T04:00:00Z') },
        ),
      ]),
    )
    expect(poolTermsFor(terms, 'HKD')?.committedMinor).toBe(0n)
  })

  it('does not double-count a scheduled credit-card payment', () => {
    // The card balance is already committed; the transfer that settles it is
    // money moving between accounts you own.
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['card', -300_000n],
          ['expenses', 300_000n],
        ]),
        ...txn(
          [
            ['hsbc', -300_000n],
            ['card', 300_000n],
          ],
          { status: 'scheduled', occurredAt: new Date('2026-08-20T04:00:00Z') },
        ),
      ]),
    )
    expect(poolTermsFor(terms, 'HKD')?.committedMinor).toBe(300_000n)
  })

  it('does not let a scheduled entry move a balance', () => {
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['hsbc', -800_000n],
            ['expenses', 800_000n],
          ],
          { status: 'scheduled', occurredAt: new Date('2026-08-25T04:00:00Z') },
        ),
      ]),
    )
    expect(poolTermsFor(terms, 'HKD')?.liquidMinor).toBe(5_000_000n)
  })
})

describe('verdict', () => {
  const terms = () => safetyTerms(input(funded))
  const hkdPayment = (amountMinor: bigint, isDiscretionary = false) => ({
    amountMinor,
    currency: 'HKD' as const,
    amountHkdMinor: amountMinor,
    isDiscretionary,
  })

  it('is SAFE well inside available, and says what runway is left', () => {
    const result = evaluatePayment(terms(), hkdPayment(10_000n))
    expect(result?.verdict).toBe('SAFE')
    expect(result?.reason).toMatch(/days of cover/)
  })

  it('is UNSAFE when it breaches the floor, and names the terms', () => {
    const available = poolTermsFor(terms(), 'HKD')!.availableMinor
    const result = evaluatePayment(terms(), hkdPayment(available + 100_000n))

    expect(result?.verdict).toBe('UNSAFE')
    expect(result?.shortfallMinor).toBe(100_000n)
    expect(result?.reason).toMatch(/45-day floor/)
    expect(result?.reason).toMatch(/HK\$50,000\.00 liquid/)
  })

  it('is exactly SAFE at the boundary', () => {
    const available = poolTermsFor(terms(), 'HKD')!.availableMinor
    expect(evaluatePayment(terms(), hkdPayment(available))?.verdict).toBe('SAFE')
    expect(evaluatePayment(terms(), hkdPayment(available + 1n))?.verdict).toBe('UNSAFE')
  })

  it('is CAUTION when affordable but over the blended budget', () => {
    const spent = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['hsbc', -250_000n],
            ['expenses', 250_000n],
          ],
          { categoryId: 'cat-food' },
        ),
      ]),
    )
    const result = evaluatePayment(spent, hkdPayment(100_000n, true))
    expect(result?.verdict).toBe('CAUTION')
    expect(result?.reason).toMatch(/over your HK\$3,000\.00 discretionary budget/)
  })

  it('applies the discretionary budget across pools, not per pool', () => {
    // Liquidity is per pool because you cannot spend baht in Hong Kong. Budget
    // is about behaviour, and eating out in Bangkok is the same habit as eating
    // out in Kowloon — a budget you could evade by crossing a border would
    // measure nothing.
    const spentInHkd = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['ktb', 25_000_000n, 'THB'],
          ['expenses', -5_000_000n],
        ]),
        ...txn(
          [
            ['hsbc', -290_000n],
            ['expenses', 290_000n],
          ],
          { categoryId: 'cat-food' },
        ),
      ]),
    )

    // A baht dinner, judged against the HKD-denominated behavioural budget.
    const result = evaluatePayment(spentInHkd, {
      amountMinor: 500_000n,
      currency: 'THB',
      amountHkdMinor: 100_000n,
      isDiscretionary: true,
    })
    expect(result?.verdict).toBe('CAUTION')
  })

  it('stays SAFE over budget when the category is not discretionary', () => {
    const spent = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['hsbc', -400_000n],
            ['expenses', 400_000n],
          ],
          { categoryId: 'cat-food' },
        ),
      ]),
    )
    expect(evaluatePayment(spent, hkdPayment(100_000n, false))?.verdict).toBe('SAFE')
  })

  it('UNSAFE beats CAUTION when both apply', () => {
    const spent = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['hsbc', -400_000n],
            ['expenses', 400_000n],
          ],
          { categoryId: 'cat-food' },
        ),
      ]),
    )
    expect(evaluatePayment(spent, hkdPayment(9_000_000n, true))?.verdict).toBe('UNSAFE')
  })

  it('reports being already past the limit plainly', () => {
    const broke = safetyTerms(
      input(
        txn([
          ['hsbc', 100_000n],
          ['expenses', -100_000n],
        ]),
      ),
    )
    const result = evaluatePayment(broke, hkdPayment(100n))
    expect(result?.verdict).toBe('UNSAFE')
    expect(result?.reason).toMatch(/already .* past your HKD limit/)
  })
})

describe('monotonicity (PLAN §5)', () => {
  it('never moves the verdict toward safety as the amount grows', () => {
    // The property that makes the rule trustworthy, and which must survive the
    // adaptive floor: the floor depends on your burn rate, never on the payment
    // being judged, so spending more can still never make a payment safer.
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn(
          [
            ['hsbc', -200_000n],
            ['expenses', 200_000n],
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

          const low = evaluatePayment(terms, {
            amountMinor: smaller,
            currency: 'HKD',
            amountHkdMinor: smaller,
            isDiscretionary,
          })!
          const high = evaluatePayment(terms, {
            amountMinor: larger,
            currency: 'HKD',
            amountHkdMinor: larger,
            isDiscretionary,
          })!

          expect(VERDICT_SEVERITY[high.verdict]).toBeGreaterThanOrEqual(
            VERDICT_SEVERITY[low.verdict],
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  it('always leaves less runway as the amount grows', () => {
    const terms = safetyTerms(input(funded))
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 4_000_000n }),
        fc.bigInt({ min: 0n, max: 4_000_000n }),
        (a, b) => {
          const [smaller, larger] = a <= b ? [a, b] : [b, a]
          const low = evaluatePayment(terms, {
            amountMinor: smaller,
            currency: 'HKD',
            amountHkdMinor: smaller,
            isDiscretionary: false,
          })!
          const high = evaluatePayment(terms, {
            amountMinor: larger,
            currency: 'HKD',
            amountHkdMinor: larger,
            isDiscretionary: false,
          })!
          expect(high.remainingRunwayDays!).toBeLessThanOrEqual(low.remainingRunwayDays!)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('is deterministic — same input, same verdict', () => {
    const payment = {
      amountMinor: 123_456n,
      currency: 'HKD' as const,
      amountHkdMinor: 123_456n,
      isDiscretionary: true,
    }
    expect(evaluatePayment(safetyTerms(input(funded)), payment)).toEqual(
      evaluatePayment(safetyTerms(input(funded)), payment),
    )
  })
})

describe('serialisation', () => {
  it('round-trips terms through JSON for the client', () => {
    const terms = safetyTerms(
      input([
        ...funded,
        ...txn([
          ['ktb', 5_000_000n, 'THB'],
          ['expenses', -1_000_000n],
        ]),
      ]),
    )
    expect(termsFromJson(JSON.parse(JSON.stringify(termsToJson(terms))))).toEqual(terms)
  })
})
