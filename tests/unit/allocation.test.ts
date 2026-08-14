import { describe, expect, it } from 'vitest'
import { evaluateInflow, type AllocationSettings } from '@/lib/domain/allocation'
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
