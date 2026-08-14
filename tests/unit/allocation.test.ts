import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  evaluateInflow,
  splitByWeight,
  type AllocationSettings,
  type WeightedTarget,
} from '@/lib/domain/allocation'
import { parseRate } from '@/lib/domain/money'

const settings: AllocationSettings = {
  thresholdHkdMinor: 200_000n, // 2,000.00 HKD
  pct: parseRate('0.30'),
}

describe('evaluateInflow', () => {
  it('does not fire below the threshold', () => {
    expect(evaluateInflow(199_999n, settings)).toBeNull()
  })

  it('fires exactly at the threshold', () => {
    // 2,000.00 * 30% = 600.00
    expect(evaluateInflow(200_000n, settings)).toEqual({
      inflowHkdMinor: 200_000n,
      suggestedHkdMinor: 60_000n,
    })
  })

  it('fires above the threshold with the configured percentage', () => {
    // 10,000.00 * 30% = 3,000.00
    expect(evaluateInflow(1_000_000n, settings)).toEqual({
      inflowHkdMinor: 1_000_000n,
      suggestedHkdMinor: 300_000n,
    })
  })

  it('never suggests more than the inflow itself, even at 100%', () => {
    const allIn: AllocationSettings = { ...settings, pct: parseRate('1') }
    const result = evaluateInflow(500_000n, allIn)
    expect(result?.suggestedHkdMinor).toBe(500_000n)
  })

  it('rounds half-even, matching every other percentage-of-money calculation', () => {
    // 205.00 HKD inflow at 30% wouldn't hit a .5 boundary, so pick a
    // threshold-and-rate combination that does: 100 minor units at 50% = 50.5.
    const halfEven: AllocationSettings = { thresholdHkdMinor: 0n, pct: parseRate('0.505') }
    // 100 * 0.505 = 50.5 → half-even rounds to 50 (even neighbour)
    expect(evaluateInflow(100n, halfEven)?.suggestedHkdMinor).toBe(50n)
  })

  it('respects a custom threshold and percentage', () => {
    const custom: AllocationSettings = { thresholdHkdMinor: 50_000n, pct: parseRate('0.10') }
    expect(evaluateInflow(49_999n, custom)).toBeNull()
    expect(evaluateInflow(50_000n, custom)?.suggestedHkdMinor).toBe(5_000n)
  })
})

describe('splitByWeight', () => {
  it('splits evenly when the amounts divide cleanly', () => {
    const targets: WeightedTarget[] = [
      { id: 'aapl', weightBps: 5000 },
      { id: 'voo', weightBps: 5000 },
    ]
    expect(splitByWeight(100n, targets)).toEqual([
      { id: 'aapl', amountMinor: 50n },
      { id: 'voo', amountMinor: 50n },
    ])
  })

  it('hands the leftover minor unit to the largest remainder, not always the first target', () => {
    // 10 split three ways at ~33.33% each: floors are 3/3/3 (sum 9), leaving
    // 1 minor unit over. The third target's remainder (3340) narrowly beats
    // the other two's (3330 each), so it — not the first-listed target —
    // gets the extra unit.
    const targets: WeightedTarget[] = [
      { id: 'a', weightBps: 3333 },
      { id: 'b', weightBps: 3333 },
      { id: 'c', weightBps: 3334 },
    ]
    expect(splitByWeight(10n, targets)).toEqual([
      { id: 'a', amountMinor: 3n },
      { id: 'b', amountMinor: 3n },
      { id: 'c', amountMinor: 4n },
    ])
  })

  it('gives a single 100%-weighted target everything', () => {
    expect(splitByWeight(777n, [{ id: 'aapl', weightBps: 10000 }])).toEqual([
      { id: 'aapl', amountMinor: 777n },
    ])
  })

  it('ignores zero-weight targets entirely', () => {
    const targets: WeightedTarget[] = [
      { id: 'aapl', weightBps: 10000 },
      { id: 'dead', weightBps: 0 },
    ]
    expect(splitByWeight(100n, targets)).toEqual([{ id: 'aapl', amountMinor: 100n }])
  })

  it('returns nothing for no targets, zero total weight, or a non-positive amount', () => {
    expect(splitByWeight(100n, [])).toEqual([])
    expect(splitByWeight(100n, [{ id: 'a', weightBps: 0 }])).toEqual([])
    expect(splitByWeight(0n, [{ id: 'a', weightBps: 10000 }])).toEqual([])
  })

  it('always sums to exactly the total, never a unit more or less', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.array(
          fc.record({ id: fc.string({ minLength: 1, maxLength: 5 }), weightBps: fc.integer({ min: 1, max: 10000 }) }),
          { minLength: 1, maxLength: 8 },
        ),
        (totalMinor, rawTargets) => {
          // De-duplicate ids — the function isn't specified for repeated ids.
          const seen = new Set<string>()
          const targets = rawTargets.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)))

          const split = splitByWeight(totalMinor, targets)
          const sum = split.reduce((acc, s) => acc + s.amountMinor, 0n)
          expect(sum).toBe(totalMinor)
          expect(split.every((s) => s.amountMinor >= 0n)).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })
})
