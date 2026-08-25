import { cn } from '@/lib/utils'

/**
 * A single headline figure with its label. Deliberately larger and tighter than
 * the surrounding text — scale contrast is what makes a dense financial page
 * scannable without adding rules or boxes.
 */
export function Stat({
  label,
  value,
  emphasis = 'normal',
}: {
  label: string
  value: string
  emphasis?: 'normal' | 'over'
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'tabular text-2xl font-semibold tracking-tight',
          emphasis === 'over' && 'text-destructive',
        )}
      >
        {value}
      </span>
    </div>
  )
}
