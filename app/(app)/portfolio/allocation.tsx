import { Progress } from '@/components/ui/progress'

export interface AllocationRow {
  readonly instrumentId: string
  readonly accountId: string
  readonly symbol: string
  readonly accountName: string
  readonly percent: number
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(2)}%`
}

/**
 * What share of total investment value each position represents, blended to
 * HKD (PLAN §7 / lib/domain/holdings.ts `computeAllocations`) — deliberately
 * no dollar figures here, since the whole point is the one number the
 * holdings table cannot give you without doing the division yourself.
 */
export function AllocationBreakdown({
  rows,
  excludedCount,
}: {
  rows: readonly AllocationRow[]
  excludedCount: number
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {excludedCount > 0
          ? 'No live prices yet — refresh prices to see allocation.'
          : 'No positions yet.'}
      </p>
    )
  }

  const sorted = [...rows].sort((a, b) => b.percent - a.percent)

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5 text-sm">
        {sorted.map((row) => (
          <li key={`${row.instrumentId}-${row.accountId}`} className="flex items-center gap-3">
            <span className="w-20 shrink-0 truncate font-medium">{row.symbol}</span>
            <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
              {row.accountName}
            </span>
            {/*
              The shared bar, whose track is `--muted` rather than the border
              colour this used to use — a track lighter than its own fill reads
              as a *full* bar in dark mode.
            */}
            <Progress value={row.percent} size="sm" className="flex-1" />
            <span className="tabular w-16 shrink-0 text-right">{formatPercent(row.percent)}</span>
          </li>
        ))}
      </ul>
      {excludedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {excludedCount} position{excludedCount === 1 ? '' : 's'} excluded — no live price yet.
        </p>
      ) : null}
    </div>
  )
}
