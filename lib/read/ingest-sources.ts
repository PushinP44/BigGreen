import 'server-only'

/**
 * Ingest heartbeat read model.
 *
 * Query only — `lib/domain/ingest-health.ts` decides what a heartbeat means
 * (PLAN §2: read models fetch rows but never decide what they mean).
 */

import type { Db } from '@/lib/db/client'
import type { IngestHeartbeatSnapshot } from '@/lib/domain/ingest-health'

interface HeartbeatRow {
  source_key: string
  last_attempt_at: string | null
  last_success_at: string | null
  expected_interval_minutes: number
  consecutive_failures: number
}

/**
 * Every registered feed's heartbeat, generic across sources rather than
 * hardcoded to FX — a later source (e.g. live prices) appears here with no UI
 * change once it starts calling the same `touchHeartbeat` pattern.
 */
export async function listIngestHeartbeats(db: Db): Promise<IngestHeartbeatSnapshot[]> {
  const result = await db.query<HeartbeatRow>(`
    SELECT source_key, last_attempt_at, last_success_at,
           expected_interval_minutes, consecutive_failures
      FROM ingest_sources
     ORDER BY source_key
  `)

  return result.rows.map((row) => ({
    sourceKey: row.source_key,
    lastAttemptAt: row.last_attempt_at === null ? null : new Date(row.last_attempt_at),
    lastSuccessAt: row.last_success_at === null ? null : new Date(row.last_success_at),
    expectedIntervalMinutes: Number(row.expected_interval_minutes),
    consecutiveFailures: Number(row.consecutive_failures),
  }))
}
