import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECONCILE_OPTIONS,
  reconcileScheduled,
  scoreMatch,
  similarity,
  type ReconcileCandidate,
} from '@/lib/domain/reconcile'

function candidate(
  id: string,
  overrides: Partial<ReconcileCandidate> = {},
): ReconcileCandidate {
  return {
    transactionId: id,
    accountId: 'bank',
    amountHkdMinor: -800_000n,
    occurredAt: new Date('2026-08-11T04:00:00Z'),
    merchant: 'CLP Power',
    description: null,
    ...overrides,
  }
}

describe('scoreMatch gates', () => {
  it('refuses a different account outright', () => {
    // Not a weak match — a different transaction. Scoring it as "somewhat
    // similar" is how a reconciler starts merging unrelated rows.
    expect(
      scoreMatch(candidate('s'), candidate('p', { accountId: 'other' })),
    ).toBeNull()
  })

  it('refuses the opposite direction', () => {
    expect(scoreMatch(candidate('s'), candidate('p', { amountHkdMinor: 800_000n }))).toBeNull()
  })

  it('refuses a payment outside the window', () => {
    expect(
      scoreMatch(
        candidate('s'),
        candidate('p', { occurredAt: new Date('2026-08-25T04:00:00Z') }),
      ),
    ).toBeNull()
  })

  it('refuses an amount outside tolerance', () => {
    expect(
      scoreMatch(candidate('s'), candidate('p', { amountHkdMinor: -900_000n })),
    ).toBeNull()
  })

  it('scores an exact same-day match at 1', () => {
    expect(scoreMatch(candidate('s'), candidate('p'))).toBe(1)
  })

  it('scores lower as the amount and date drift', () => {
    const exact = scoreMatch(candidate('s'), candidate('p'))!
    const drifted = scoreMatch(
      candidate('s'),
      candidate('p', {
        amountHkdMinor: -802_500n,
        occurredAt: new Date('2026-08-14T04:00:00Z'),
      }),
    )!
    expect(drifted).toBeLessThan(exact)
    expect(drifted).toBeGreaterThan(0)
  })

  it('tolerates a bill that is not the exact figure you scheduled', () => {
    // HK$31.20 off an HK$8,000 electricity bill, paid a day late. That is an
    // ordinary month and must clear the auto-merge threshold — otherwise the
    // reconciler proposes rather than merges every single time and the
    // double-count it exists to prevent survives.
    const score = scoreMatch(
      candidate('s'),
      candidate('p', { amountHkdMinor: -803_120n, occurredAt: new Date('2026-08-12T04:00:00Z') }),
    )
    expect(score).not.toBeNull()
    expect(score!).toBeGreaterThan(0.75)
  })

  it('scores by relative difference, not against a flat tolerance', () => {
    // The same HK$31.20 gap is noise on an HK$8,000 bill and suspicious on an
    // HK$60 one. An absolute-only score cannot tell those apart.
    const bigBill = scoreMatch(
      candidate('s', { amountHkdMinor: -800_000n }),
      candidate('p', { amountHkdMinor: -803_120n }),
    )!
    const smallBill = scoreMatch(
      candidate('s', { amountHkdMinor: -6_000n }),
      candidate('p', { amountHkdMinor: -9_120n }),
    )!

    expect(bigBill).toBeGreaterThan(0.9)
    expect(smallBill).toBeLessThan(bigBill)
  })

  it('gates large bills by percentage, not by the flat tolerance', () => {
    // 1% of a 100,000 bill is 1,000 — well past the flat HK$50 gate, but
    // clearly the same bill.
    const score = scoreMatch(
      candidate('s', { amountHkdMinor: -10_000_000n }),
      candidate('p', { amountHkdMinor: -10_100_000n }),
    )
    expect(score).not.toBeNull()
  })
})

describe('reconcileScheduled', () => {
  it('matches a commitment to its payment', () => {
    const result = reconcileScheduled([candidate('sched')], [candidate('paid')])

    expect(result.matches).toEqual([
      { scheduledId: 'sched', postedId: 'paid', score: 1, autoMerge: true },
    ])
    expect(result.unmatchedScheduled).toEqual([])
  })

  it('never lets one payment reconcile two commitments', () => {
    // Three months of the same standing bill, one payment. Matching all three
    // would silently erase two real commitments from the safety rule.
    const scheduled = [
      candidate('aug', { occurredAt: new Date('2026-08-11T04:00:00Z') }),
      candidate('aug-2', { occurredAt: new Date('2026-08-12T04:00:00Z') }),
      candidate('aug-3', { occurredAt: new Date('2026-08-13T04:00:00Z') }),
    ]
    const result = reconcileScheduled(scheduled, [candidate('paid')])

    expect(result.matches).toHaveLength(1)
    expect(result.unmatchedScheduled).toHaveLength(2)
  })

  it('never lets one commitment absorb two payments', () => {
    const result = reconcileScheduled(
      [candidate('sched')],
      [candidate('paid-1'), candidate('paid-2', { occurredAt: new Date('2026-08-12T04:00:00Z') })],
    )
    expect(result.matches).toHaveLength(1)
  })

  it('prefers the closest payment when several qualify', () => {
    const result = reconcileScheduled(
      [candidate('sched')],
      [
        candidate('far', { occurredAt: new Date('2026-08-16T04:00:00Z') }),
        candidate('exact'),
      ],
    )
    expect(result.matches[0]?.postedId).toBe('exact')
  })

  it('reports commitments with no payment as still outstanding', () => {
    const result = reconcileScheduled([candidate('sched')], [])
    expect(result.matches).toEqual([])
    expect(result.unmatchedScheduled).toEqual(['sched'])
  })

  it('proposes rather than merges below the threshold', () => {
    const result = reconcileScheduled(
      [candidate('sched', { merchant: 'CLP Power' })],
      [
        candidate('paid', {
          merchant: 'Something else entirely',
          amountHkdMinor: -804_500n,
          occurredAt: new Date('2026-08-17T04:00:00Z'),
        }),
      ],
    )
    expect(result.matches[0]?.autoMerge).toBe(false)
  })

  it('is deterministic when scores tie', () => {
    // Equal scores must not resolve by whatever order the database returned.
    const scheduled = [candidate('b'), candidate('a')]
    const posted = [candidate('y'), candidate('x')]

    const first = reconcileScheduled(scheduled, posted)
    const second = reconcileScheduled([...scheduled].reverse(), [...posted].reverse())
    expect(first.matches).toEqual(second.matches)
  })

  it('handles empty input', () => {
    expect(reconcileScheduled([], [])).toEqual({ matches: [], unmatchedScheduled: [] })
  })

  it('respects a zero window and zero tolerance', () => {
    const strict = {
      ...DEFAULT_RECONCILE_OPTIONS,
      windowDays: 0,
      amountToleranceHkdMinor: 0n,
      amountToleranceFraction: 0,
    }
    expect(reconcileScheduled([candidate('s')], [candidate('p')], strict).matches).toHaveLength(1)
    expect(
      reconcileScheduled([candidate('s')], [candidate('p', { amountHkdMinor: -800_001n })], strict)
        .matches,
    ).toHaveLength(0)
  })
})

describe('similarity', () => {
  it('is 1 for identical text and 0 for disjoint', () => {
    expect(similarity('CLP Power', 'CLP Power')).toBe(1)
    expect(similarity('CLP Power', 'Watsons')).toBe(0)
  })

  it('ignores case and punctuation', () => {
    expect(similarity('CLP Power', 'clp, power!')).toBe(1)
  })

  it('is 0 when either side is empty', () => {
    expect(similarity('', 'CLP')).toBe(0)
    expect(similarity('CLP', '')).toBe(0)
  })

  it('handles Chinese merchant names', () => {
    expect(similarity('中電 power', '中電 power')).toBe(1)
  })
})
