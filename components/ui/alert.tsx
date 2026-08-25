import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * The boxed callout — the ledger-unbalanced banner on the dashboard and the
 * "check your email" confirmation on the login page, which were each spelled
 * out inline.
 *
 * Inline form feedback next to a submit button is `<FormStatus>` instead; this
 * is for something that needs its own block.
 */
const alertVariants = cva(
  'flex flex-col gap-1 rounded-lg border px-4 py-3 text-sm',
  {
    variants: {
      variant: {
        info: 'border-border bg-muted/60 text-foreground',
        success: 'border-primary/40 bg-primary/5 text-foreground',
        warning: 'border-warning/40 bg-warning/5 text-foreground',
        destructive: 'border-destructive/40 bg-destructive/5 text-destructive',
      },
    },
    defaultVariants: { variant: 'info' },
  },
)

export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      // `alert` is assertive and interrupts a screen reader mid-sentence, which
      // is right for "your ledger does not balance" and wrong for a friendly
      // confirmation — so only the destructive variant claims it.
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

export function AlertTitle({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p data-slot="alert-title" className={cn('font-medium', className)} {...props} />
  )
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export { alertVariants }
