import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Replaces the `const field = '…'` string that was copy-pasted into 11 files —
 * one of which had already drifted (an extra `text-sm` in
 * app/allocations/suggestion-row.tsx).
 *
 * Deliberately still a plain `<input>`: every form in this app is a React 19
 * Server Action form whose fields are read out of `FormData` by `name`, so the
 * element has to remain a real form control.
 */
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base',
        'transition-[color,border-color,box-shadow] outline-none md:text-sm',
        'placeholder:text-muted-foreground/70',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
        className,
      )}
      {...props}
    />
  )
}
