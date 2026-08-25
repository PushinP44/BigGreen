import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Replaces the table classes copy-pasted across four real tables (and three
 * `<ul>`s dressed as tables), and tightens them for the editorial direction:
 * shorter rows, hairline rules, small-caps headers.
 *
 * `Table` ships its own horizontal scroll container. The 8-column holdings
 * table overflows on a phone no matter how tight the type is, and a table that
 * scrolls inside its own box is far better than one that widens the page.
 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full border-collapse text-sm', className)}
        {...props}
      />
    </div>
  )
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn(className)} {...props} />
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn(className)} {...props} />
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-b border-border/60 transition-colors hover:bg-muted/40', className)}
      {...props}
    />
  )
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'border-b border-border py-2 pr-4 text-left align-bottom',
        'text-xs font-medium uppercase tracking-wider text-muted-foreground',
        'last:pr-0',
        className,
      )}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td data-slot="table-cell" className={cn('py-2 pr-4 align-middle last:pr-0', className)} {...props} />
  )
}

/** Footnote under a table — the "P/L totals exclude COST UNKNOWN" register. */
export function TableCaption({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="table-caption"
      className={cn('pt-2 text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}
