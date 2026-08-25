import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * The form-field wrapper, replacing `<label className="flex flex-col gap-1">` —
 * 46 occurrences across 16 files — and the `const label = '…'` caption string
 * duplicated in 9 more.
 *
 * Stays a wrapping `<label>` rather than a `<div>` + `htmlFor`: the association
 * is then implicit and cannot rot, which is why no call site in the app has
 * ever needed an id. That is also why there is no Radix `Label` here — it earns
 * its keep for standalone captions, and this app has none.
 */
export function Field({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label data-slot="field" className={cn('flex flex-col gap-1.5', className)} {...props} />
  )
}

/**
 * Small-caps caption. Wide tracking at this size is what keeps it legible as a
 * label rather than reading as shouted body text.
 */
export function FieldLabel({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="field-label"
      className={cn(
        'text-xs font-medium uppercase tracking-wider text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

/** Helper text under a control — the "leave blank if unknown" register. */
export function FieldHint({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="field-hint"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}
