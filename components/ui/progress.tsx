import { cn } from '@/lib/utils'

/**
 * The three hand-rolled progress bars (discretionary budget, per-category
 * spend, allocation share) collapsed into one.
 *
 * The track is `bg-muted`, **not** `bg-border`. Those bars previously used the
 * border colour as their empty track, which the old globals.css comment flagged
 * as a hazard: a track that is lighter than the fill reads as a *full* bar in
 * dark mode. `--muted` is a surface token and stays darker than `--primary` in
 * both themes, so an empty bar looks empty.
 *
 * Not Radix's Progress: these are decorative summaries of a figure already
 * printed in text beside them, so the ARIA progressbar role and its
 * now/min/max wiring would be noise for a screen reader. `aria-hidden` says
 * that explicitly.
 */
export function Progress({
  value,
  className,
  indicatorClassName,
  size = 'default',
}: {
  /** 0–100. Clamped here so a caller cannot overflow the track. */
  value: number
  className?: string
  indicatorClassName?: string
  size?: 'sm' | 'default'
}) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <span
      data-slot="progress"
      aria-hidden
      className={cn(
        'block overflow-hidden rounded-full bg-muted',
        size === 'sm' ? 'h-1.5' : 'h-2',
        className,
      )}
    >
      <span
        data-slot="progress-indicator"
        className={cn('block h-full rounded-full bg-primary transition-[width]', indicatorClassName)}
        style={{ width: `${pct}%` }}
      />
    </span>
  )
}
