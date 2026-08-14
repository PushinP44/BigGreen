/**
 * Ingest heartbeat health.
 *
 * `ingest_sources` has recorded when an external feed last attempted and last
 * succeeded since the FX job existed, but nothing has ever read it back — a
 * dead feed and a quiet market look identical without this (PLAN §6.7,
 * "every other item on the dashboard degrades silently; this one degrades
 * loudly").
 *
 * Pure: takes a snapshot and an explicit `now`. No database, no clock, no I/O.
 */

export interface IngestHeartbeatSnapshot {
  readonly sourceKey: string
  readonly lastAttemptAt: Date | null
  readonly lastSuccessAt: Date | null
  readonly expectedIntervalMinutes: number
  readonly consecutiveFailures: number
}

export type HeartbeatStatus = 'ok' | 'never_run' | 'stale' | 'failing'

/**
 * A source with recorded failures is failing regardless of timing — a job
 * that fails every run but happens to run on schedule is not healthy just
 * because it is punctual. `never_run`/`lastSuccessAt === null` covers both "no
 * attempt yet" and "attempted, but not once cleanly succeeded" (reachable when
 * every run partially rejects without throwing, e.g. every fetched rate fails
 * continuity — see `frankfurter.ts`'s `syncRates`) — the actionable message to
 * the user is the same either way: nothing has worked yet.
 */
export function heartbeatStatus(heartbeat: IngestHeartbeatSnapshot, now: Date): HeartbeatStatus {
  if (heartbeat.consecutiveFailures > 0) return 'failing'
  if (heartbeat.lastAttemptAt === null || heartbeat.lastSuccessAt === null) return 'never_run'

  const staleAfterMs = 2 * heartbeat.expectedIntervalMinutes * 60_000
  if (now.getTime() - heartbeat.lastSuccessAt.getTime() > staleAfterMs) return 'stale'

  return 'ok'
}

/**
 * Ranking for display (worst first) and for the monotonicity property test:
 * for a fixed heartbeat, status can only get worse as `now` moves later, never
 * better — mirrors `safety.ts`'s `VERDICT_SEVERITY`.
 */
export const HEARTBEAT_SEVERITY: Record<HeartbeatStatus, number> = {
  ok: 0,
  never_run: 1,
  stale: 2,
  failing: 3,
}
