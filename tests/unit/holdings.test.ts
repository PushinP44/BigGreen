import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  computeAllocations,
  computeHoldings,
  multiplyQuantityByPriceMinor,
  parseQuantity,
  percentChange,
  priceToAmountMinor,
  quantityToString,
  type AllocationInput,
  type HoldingEntrySnapshot,
} from '@/lib/domain/holdings'

function leg(
  instrumentId: string,
  quantityDelta: string,
  amountMinor: bigint,
  accountId = 'acct-1',
): HoldingEntrySnapshot {
  return { instrumentId, accountId, quantityDelta, amountMinor }
}

describe('parseQuantity / quantityToString', () => {
  it('round-trips whole, fractional and negative quantities', () => {
    const cases: Array<[input: string, expected: string]> = [
      ['10', '10.0000000000'],
      ['0.5', '0.5000000000'],
      ['-3.25', '-3.2500000000'],
      ['1234.1234567890', '1234.1234567890'],
      ['0', '0.0000000000'],
    ]
    for (const [input, expected] of cases) {
      expect(quantityToString(parseQuantity(input))).toBe(expected)
    }
  })

  it('rejects garbage input', () => {
    expect(() => parseQuantity('ten')).toThrow(/invalid quantity/)
    expect(() => parseQuantity('')).toThrow(/invalid quantity/)
  })
})

describe('multiplyQuantityByPriceMinor', () => {
  it('multiplies quantity by a per-share minor-unit price', () => {
    // 10 shares at $150.00 (15000 minor units) = $1,500.00
    expect(multiplyQuantityByPriceMinor(parseQuantity('10'), 15000n)).toBe(150000n)
  })

  it('rounds half-even on a fractional quantity', () => {
    // 0.5 shares at 1 minor unit = 0.5 → rounds to even (0)
    expect(multiplyQuantityByPriceMinor(parseQuantity('0.5'), 1n)).toBe(0n)
    // 1.5 shares at 1 minor unit = 1.5 → rounds to even (2)
    expect(multiplyQuantityByPriceMinor(parseQuantity('1.5'), 1n)).toBe(2n)
  })
})

describe('priceToAmountMinor', () => {
  it('matches a fund trade confirmation stated to the cent', () => {
    // Real Mox alert: 400.0000 units @ HKD11.2554, total HKD4,502.16 —
    // a price with more decimal places than HKD's own minor unit.
    expect(priceToAmountMinor('400.0000', '11.2554', 'HKD')).toBe(450216n)
  })

  it('matches a share trade with a whole-cent price', () => {
    // Real ZA alert: 30 shares @ USD3.6100 — no total is stated, so this is
    // the only way to get one.
    expect(priceToAmountMinor('30', '3.6100', 'USD')).toBe(10830n)
  })

  it('rounds an exact half-cent to the nearest even cent, both directions', () => {
    // 1 @ 1.005 = 1.005 exactly -> nearest even cent is 100 (not 101)
    expect(priceToAmountMinor('1', '1.005', 'USD')).toBe(100n)
    // 1 @ 1.015 = 1.015 exactly -> nearest even cent is 102 (not 101)
    expect(priceToAmountMinor('1', '1.015', 'USD')).toBe(102n)
  })

  it('rejects a non-decimal quantity or price', () => {
    expect(() => priceToAmountMinor('abc', '1.00', 'USD')).toThrow(/invalid decimal/)
    expect(() => priceToAmountMinor('1', 'abc', 'USD')).toThrow(/invalid decimal/)
  })
})

describe('computeHoldings', () => {
  it('accumulates a single buy', () => {
    const entries = [leg('aapl', '10', 150000n)]
    const [result] = computeHoldings(entries)
    expect(result?.quantity).toEqual(parseQuantity('10'))
    expect(result?.avgCostMinor).toBe(15000n) // 150000 / 10
  })

  it('averages cost across two buys at different prices', () => {
    const entries = [
      leg('aapl', '10', 150000n), // 10 @ 150.00
      leg('aapl', '10', 170000n), // 10 @ 170.00
    ]
    const [result] = computeHoldings(entries)
    expect(result?.quantity).toEqual(parseQuantity('20'))
    expect(result?.avgCostMinor).toBe(16000n) // (150000+170000) / 20 = 160.00
  })

  it('excludes a zero-cost legacy leg from avg cost but still counts its quantity', () => {
    // The rule most likely to be gotten wrong: a legacy add with unknown cost
    // must move quantity without corrupting avgCost toward zero.
    const entries = [
      leg('aapl', '5', 0n), // legacy: 5 shares, cost unknown
      leg('aapl', '10', 150000n), // 10 @ 150.00, known
    ]
    const [result] = computeHoldings(entries)
    expect(result?.quantity).toEqual(parseQuantity('15'))
    // avgCost reflects ONLY the known-cost 10 shares, not diluted by the 5 unknown ones.
    expect(result?.avgCostMinor).toBe(15000n)
  })

  it('reports COST UNKNOWN (null) when every leg has unknown cost', () => {
    const entries = [leg('aapl', '5', 0n)]
    const [result] = computeHoldings(entries)
    expect(result?.quantity).toEqual(parseQuantity('5'))
    expect(result?.avgCostMinor).toBeNull()
  })

  it('does not perturb avg cost when part of the position is sold', () => {
    // Buy 10 @ 150.00, sell 4. The naive-but-wrong implementation folds the
    // sell's amount into the cost sum and corrupts the average; this asserts
    // the average-cost-method convention: the remaining position's average
    // holds steady across a sale.
    const entries = [
      leg('aapl', '10', 150000n), // buy 10 @ 150.00
      leg('aapl', '-4', 68000n), // sell 4 @ 170.00 (proceeds, not cost)
    ]
    const [result] = computeHoldings(entries)
    expect(result?.quantity).toEqual(parseQuantity('6'))
    expect(result?.avgCostMinor).toBe(15000n) // unchanged by the sale
  })

  it('omits a position netted to exactly zero', () => {
    const entries = [leg('aapl', '10', 150000n), leg('aapl', '-10', 160000n)]
    expect(computeHoldings(entries)).toEqual([])
  })

  it('keeps positions in different instruments independent', () => {
    const entries = [leg('aapl', '10', 150000n), leg('voo', '5', 250000n)]
    const results = computeHoldings(entries)
    const byId = new Map(results.map((r) => [r.instrumentId, r]))
    expect(byId.get('aapl')?.quantity).toEqual(parseQuantity('10'))
    expect(byId.get('voo')?.quantity).toEqual(parseQuantity('5'))
  })

  it('keeps the same instrument in two different accounts independent, never merged', () => {
    // The same stock at two different brokers is two positions, not one —
    // this is what lets the UI show "AAPL 2 shares in ZA" and "AAPL 3 shares
    // in Mox" as separate rows rather than a single blended "AAPL 5 shares"
    // that hides which account either half is actually sitting in.
    const entries = [
      leg('aapl', '10', 150000n, 'za'), // 10 @ 150.00 in ZA
      leg('aapl', '5', 90000n, 'mox'), // 5 @ 180.00 in Mox
    ]
    const results = computeHoldings(entries)
    expect(results).toHaveLength(2)

    const za = results.find((r) => r.accountId === 'za')
    const mox = results.find((r) => r.accountId === 'mox')
    expect(za?.instrumentId).toBe('aapl')
    expect(za?.quantity).toEqual(parseQuantity('10'))
    expect(za?.avgCostMinor).toBe(15000n)
    expect(mox?.instrumentId).toBe('aapl')
    expect(mox?.quantity).toEqual(parseQuantity('5'))
    expect(mox?.avgCostMinor).toBe(18000n)
  })

  it('omits a zero-net position in one account while keeping it in another', () => {
    const entries = [
      leg('aapl', '10', 150000n, 'za'),
      leg('aapl', '-10', 160000n, 'za'), // fully sold in ZA
      leg('aapl', '3', 45000n, 'mox'), // still held in Mox
    ]
    const results = computeHoldings(entries)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ instrumentId: 'aapl', accountId: 'mox' })
  })

  it('is order-independent — summing entries in any order gives the same quantity', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('aapl', 'voo'),
            fc.constantFrom('za', 'mox'),
            fc.integer({ min: -1000, max: 1000 }),
            fc.bigInt({ min: 0n, max: 10n ** 7n }),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (deltas) => {
          const entries = deltas.map(([instrumentId, accountId, qty, amount]) =>
            leg(instrumentId, qty.toString(), qty > 0 ? amount : 0n, accountId),
          )
          const shuffled = [...entries].reverse()

          const totalsOf = (rows: HoldingEntrySnapshot[]) => {
            const result = computeHoldings(rows)
            return new Map(result.map((r) => [`${r.instrumentId} ${r.accountId}`, r.quantity.scaled]))
          }

          const a = totalsOf(entries)
          const b = totalsOf(shuffled)
          expect(a).toEqual(b)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('percentChange', () => {
  it('reports a gain as a positive percent', () => {
    // Paid 1,500.00, now worth 1,650.00 — up 10%.
    expect(percentChange(150000n, 165000n)).toBe(10)
  })

  it('reports a loss as a negative percent', () => {
    // Paid 1,500.00, now worth 1,200.00 — down 20%.
    expect(percentChange(150000n, 120000n)).toBe(-20)
  })

  it('is exactly zero when value has not moved from cost', () => {
    expect(percentChange(150000n, 150000n)).toBe(0)
  })

  it('is null when the cost basis is unknown', () => {
    // COST UNKNOWN (PLAN §3) — a percent of an unknown base is equally unknown.
    expect(percentChange(null, 165000n)).toBeNull()
  })

  it('is null when there is no current value yet', () => {
    expect(percentChange(150000n, null)).toBeNull()
  })

  it('is null rather than dividing by zero when the cost basis is exactly zero', () => {
    expect(percentChange(0n, 100n)).toBeNull()
  })
})

function allocationInput(
  instrumentId: string,
  accountId: string,
  valueHkdMinor: bigint | null,
): AllocationInput {
  return { instrumentId, accountId, valueHkdMinor }
}

describe('computeAllocations', () => {
  it('gives a single position 100% of the total', () => {
    const shares = computeAllocations([allocationInput('aapl', 'za', 100000n)])
    expect(shares).toHaveLength(1)
    expect(shares[0]?.percent).toBe(100)
  })

  it('splits two positions proportionally to their HKD value', () => {
    const shares = computeAllocations([
      allocationInput('aapl', 'za', 300000n), // 75%
      allocationInput('voo', 'za', 100000n), // 25%
    ])
    const byId = new Map(shares.map((s) => [s.instrumentId, s.percent]))
    expect(byId.get('aapl')).toBeCloseTo(75, 10)
    expect(byId.get('voo')).toBeCloseTo(25, 10)
  })

  it('excludes an unpriced position from both the numerator and the denominator', () => {
    // The naive-but-wrong implementation counts a null as zero, which
    // shrinks every OTHER position's percentage instead of shrinking the
    // total — this asserts the priced position still reads 100%, not some
    // fraction diluted by a position with no price at all.
    const shares = computeAllocations([
      allocationInput('aapl', 'za', 100000n),
      allocationInput('grab', 'za', null),
    ])
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ instrumentId: 'aapl', percent: 100 })
  })

  it('returns an empty array when every position is unpriced', () => {
    expect(computeAllocations([allocationInput('aapl', 'za', null)])).toEqual([])
  })

  it('returns an empty array for no positions', () => {
    expect(computeAllocations([])).toEqual([])
  })

  it('keeps the same instrument in two accounts as two independent shares', () => {
    const shares = computeAllocations([
      allocationInput('aapl', 'za', 100000n),
      allocationInput('aapl', 'mox', 100000n),
    ])
    expect(shares).toHaveLength(2)
    for (const share of shares) expect(share.percent).toBeCloseTo(50, 10)
  })

  it('priced positions always sum to 100%, regardless of how many or their split', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: 1, maxLength: 20 }),
        (values) => {
          const shares = computeAllocations(
            values.map((v, i) => allocationInput(`i${i}`, 'za', v)),
          )
          const total = shares.reduce((sum, s) => sum + s.percent, 0)
          expect(total).toBeCloseTo(100, 6)
        },
      ),
      { numRuns: 200 },
    )
  })
})
