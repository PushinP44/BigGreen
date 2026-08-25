import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Covers the five pill treatments the app grew independently: `liquid`,
 * `transfer`, the position mode label, the stale-price `{n}d old` marker, and
 * the two nav count pills — the last of which were hand-written full class
 * strings rather than reusing the `chip` constant next to them.
 *
 * `success`/`warning` map to the new semantic tokens rather than to
 * `text-amber-600 dark:text-amber-400` pairs, which is how these were spelled
 * in 84 places for want of anywhere better to put them.
 */
const badgeVariants = cva(
  [
    'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded',
    'px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3",
  ],
  {
    variants: {
      variant: {
        neutral: 'bg-muted text-muted-foreground',
        success: 'bg-primary/15 text-primary',
        warning: 'bg-warning/15 text-warning',
        destructive: 'bg-destructive/15 text-destructive',
        outline: 'border border-border text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
)

export function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { badgeVariants }
