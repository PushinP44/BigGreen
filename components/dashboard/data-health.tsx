import {
  heartbeatStatus,
  type HeartbeatStatus,
  type IngestHeartbeatSnapshot,
} from '@/lib/domain/ingest-health'
import { FX_SOURCE_KEY } from '@/lib/fx/frankfurter'
import { PRICES_SOURCE_KEY } from '@/lib/fx/finnhub'
import { shortDate } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Whether the background feeds are actually running.
 *
 * Written since the FX job existed but never shown until the redesign — a dead
 * feed and a quiet market look identical without it (PLAN §6.7). Visible on
 * load rather than only after clicking Refresh.
 */
const HEALTH_COLOR: Record<HeartbeatStatus, string> = {
  ok: 'bg-primary',
  never_run: 'bg-muted-foreground',
  stale: 'bg-warning',
  failing: 'bg-destructive',
}

const HEALTH_LABEL: Record<HeartbeatStatus, string> = {
  ok: 'healthy',
  never_run: 'never run',
  stale: 'overdue',
  failing: 'failing',
}

export function DataHealth({
  heartbeats,
  now,
}: {
  heartbeats: readonly IngestHeartbeatSnapshot[]
  now: Date
}) {
  if (heartbeats.length === 0) return null

  return (
    <dl className="flex flex-col gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
      <dt className="font-medium uppercase tracking-wider">Data health</dt>
      {heartbeats.map((heartbeat) => {
        const status = heartbeatStatus(heartbeat, now)
        return (
          <dd key={heartbeat.sourceKey} className="flex items-center gap-2">
            <span
              className={cn('inline-block size-1.5 shrink-0 rounded-full', HEALTH_COLOR[status])}
              aria-hidden
            />
            {/*
              The dot repeats what the summary already says in words. Colour is
              never the only carrier of the state — `sr-only` gives a screen
              reader the same signal the dot gives everyone else.
            */}
            <span className="sr-only">{HEALTH_LABEL[status]}:</span>
            <span>{sourceLabel(heartbeat.sourceKey)}</span>
            <span>{healthSummary(heartbeat, now)}</span>
          </dd>
        )
      })}
    </dl>
  )
}

function sourceLabel(sourceKey: string): string {
  if (sourceKey === FX_SOURCE_KEY) return 'Exchange rates'
  if (sourceKey === PRICES_SOURCE_KEY) return 'Live prices'
  return sourceKey
}

function healthSummary(heartbeat: IngestHeartbeatSnapshot, now: Date): string {
  const status = heartbeatStatus(heartbeat, now)
  if (status === 'failing') return `failing — ${heartbeat.consecutiveFailures}× in a row`
  if (heartbeat.lastSuccessAt === null) return 'never run'
  const summary = `last succeeded ${shortDate(heartbeat.lastSuccessAt)}`
  return status === 'stale' ? `${summary} — overdue` : summary
}
