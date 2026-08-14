import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  computeHoldings,
  multiplyQuantityByPriceMinor,
  parseQuantity,
  quantityToString,
  type HoldingEntrySnapshot,
} from '@/lib/domain/holdings'

function leg(
  instrumentId: string,
  quantityDelta: string,
  amountMinor: bigint,
): HoldingEntrySnapshot {
  return { instrumentId, quantityDelta, amountMinor }
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

  it('is order-independent — summing entries in any order gives the same quantity', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('aapl', 'voo'),
            fc.integer({ min: -1000, max: 1000 }),
            fc.bigInt({ min: 0n, max: 10n ** 7n }),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (deltas) => {
          const entries = deltas.map(([instrumentId, qty, amount]) =>
            leg(instrumentId, qty.toString(), qty > 0 ? amount : 0n),
          )
          const shuffled = [...entries].reverse()

          const totalsOf = (rows: HoldingEntrySnapshot[]) => {
            const result = computeHoldings(rows)
            return new Map(result.map((r) => [r.instrumentId, r.quantity.scaled]))
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
