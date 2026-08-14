import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  HEARTBEAT_SEVERITY,
  heartbeatStatus,
  type IngestHeartbeatSnapshot,
} from '@/lib/domain/ingest-health'

const now = new Date('2026-08-14T12:00:00Z')

function heartbeat(overrides: Partial<IngestHeartbeatSnapshot> = {}): IngestHeartbeatSnapshot {
  return {
    sourceKey: 'fx:frankfurter',
    lastAttemptAt: null,
    lastSuccessAt: null,
    expectedIntervalMinutes: 1440, // daily
    consecutiveFailures: 0,
    ...overrides,
  }
}

describe('heartbeatStatus', () => {
  it('is never_run before the first attempt', () => {
    expect(heartbeatStatus(heartbeat(), now)).toBe('never_run')
  })

  it('is never_run when attempted but not once cleanly succeeded', () => {
    // Reachable when every run partially rejects without throwing — e.g. every
    // fetched FX rate fails the continuity check in `frankfurter.ts`'s
    // `syncRates`, which leaves `lastSuccessAt` null and never increments
    // `consecutiveFailures` either, since no exception was thrown.
    const h = heartbeat({ lastAttemptAt: new Date('2026-08-14T00:00:00Z') })
    expect(heartbeatStatus(h, now)).toBe('never_run')
  })

  it('is ok shortly after a success, within the expected interval', () => {
    const h = heartbeat({
      lastAttemptAt: new Date('2026-08-14T11:00:00Z'),
      lastSuccessAt: new Date('2026-08-14T11:00:00Z'),
    })
    expect(heartbeatStatus(h, now)).toBe('ok')
  })

  it('is stale once a success is more than 2x the expected interval old', () => {
    // Daily job (1440 min), so stale after 2 days. Last success 3 days ago.
    const h = heartbeat({
      lastAttemptAt: new Date('2026-08-11T12:00:00Z'),
      lastSuccessAt: new Date('2026-08-11T12:00:00Z'),
    })
    expect(heartbeatStatus(h, now)).toBe('stale')
  })

  it('is exactly at the boundary — not yet stale at precisely 2x the interval', () => {
    const h = heartbeat({
      lastAttemptAt: new Date('2026-08-12T12:00:00Z'),
      lastSuccessAt: new Date('2026-08-12T12:00:00Z'), // exactly 48h before `now`
    })
    expect(heartbeatStatus(h, now)).toBe('ok')
  })

  it('is stale one millisecond past exactly 2x the interval', () => {
    const h = heartbeat({
      lastAttemptAt: new Date('2026-08-12T11:59:59.999Z'),
      lastSuccessAt: new Date('2026-08-12T11:59:59.999Z'),
    })
    expect(heartbeatStatus(h, now)).toBe('stale')
  })

  it('is failing whenever there are consecutive failures, regardless of timing', () => {
    const h = heartbeat({
      lastAttemptAt: now,
      lastSuccessAt: now, // a success just now
      consecutiveFailures: 1, // but the most recent run still failed
    })
    expect(heartbeatStatus(h, now)).toBe('failing')
  })

  it('failing takes precedence over never_run too', () => {
    const h = heartbeat({ consecutiveFailures: 3 })
    expect(heartbeatStatus(h, now)).toBe('failing')
  })
})

describe('HEARTBEAT_SEVERITY monotonicity', () => {
  it('never decreases as `now` moves later, for a fixed heartbeat', () => {
    fc.assert(
      fc.property(
        fc.record({
          hasAttempt: fc.boolean(),
          hasSuccess: fc.boolean(),
          successOffsetMinutes: fc.integer({ min: 0, max: 20_000 }),
          expectedIntervalMinutes: fc.integer({ min: 1, max: 10_000 }),
          consecutiveFailures: fc.integer({ min: 0, max: 5 }),
          laterOffsetMinutes: fc.integer({ min: 0, max: 50_000 }),
        }),
        ({
          hasAttempt,
          hasSuccess,
          successOffsetMinutes,
          expectedIntervalMinutes,
          consecutiveFailures,
          laterOffsetMinutes,
        }) => {
          const base = new Date('2026-08-14T12:00:00Z')
          const successAt = hasSuccess
            ? new Date(base.getTime() - successOffsetMinutes * 60_000)
            : null
          const h = heartbeat({
            lastAttemptAt: hasAttempt || hasSuccess ? (successAt ?? base) : null,
            lastSuccessAt: successAt,
            expectedIntervalMinutes,
            consecutiveFailures,
          })

          const earlier = HEARTBEAT_SEVERITY[heartbeatStatus(h, base)]
          const later = HEARTBEAT_SEVERITY[heartbeatStatus(h, new Date(base.getTime() + laterOffsetMinutes * 60_000))]

          expect(later).toBeGreaterThanOrEqual(earlier)
        },
      ),
      { numRuns: 300 },
    )
  })
})
