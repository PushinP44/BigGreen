'use client'

import { cn } from '@/lib/utils'

/**
 * The three-way flow switch — Spend / Income / Transfer on the entry form, and
 * Buy / Sell on the position form.
 *
 * Both were hand-rolled, and they had already diverged on accessibility: the
 * entry form set `aria-pressed`, the position form set nothing, so its selected
 * segment was announced as an ordinary button. Sharing the component is what
 * makes that class of drift impossible rather than merely fixed once.
 *
 * `aria-pressed` on grouped toggles (rather than `role="radio"`) is the shape
 * Radix's own single-select ToggleGroup settles on, and it keeps each segment a
 * real `<button>` — which matters here, because these sit inside Server Action
 * forms where the value travels in a hidden input.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>
  readonly value: T
  readonly onChange: (value: T) => void
  /** Names the group for a screen reader — "Transaction kind", not "group". */
  readonly label: string
  readonly className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex gap-1 self-start rounded-lg border border-border p-1', className)}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={cn(
              'rounded-md px-4 py-1.5 text-sm font-medium outline-none',
              'transition-[color,background-color,box-shadow]',
              'focus-visible:ring-[3px] focus-visible:ring-ring/40',
              selected
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
