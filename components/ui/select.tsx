import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * A styled **native** `<select>`, not Radix's.
 *
 * This is a deliberate departure from shadcn. Radix Select renders a button
 * plus a portalled listbox, which contributes nothing to `FormData` unless its
 * `name` is wired through to a hidden native control. Every one of the app's 13
 * selects lives inside a Server Action form and is read server-side by name, so
 * getting that wrong does not throw — the field simply never saves. In a money
 * tracker, "the category silently didn't stick" is a worse failure than any
 * styling gain.
 *
 * The native dropdown chevron and popup are kept rather than replaced with an
 * `appearance-none` + icon overlay: the popup is OS-drawn and follows
 * `color-scheme`, which globals.css now drives from the theme class, so it
 * matches in both themes for free.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base',
        'transition-[color,border-color,box-shadow] outline-none md:text-sm',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
        className,
      )}
      {...props}
    />
  )
}
