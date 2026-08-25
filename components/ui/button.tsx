import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Variants are drawn from what the app already had, not from shadcn's defaults:
 * seven distinct button treatments were hand-rolled across 25 call sites, and
 * every one of them re-declared `disabled:opacity-50` and its own focus
 * behaviour (usually none).
 *
 * `outlineDestructive` exists because the app's destructive buttons — Discard,
 * Remove, Confirm dismiss — are outline buttons that turn red on hover, not
 * shadcn's solid red `destructive`. Solid red for a routine "remove this typo"
 * would overstate it.
 */
const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md',
    'font-medium transition-[color,background-color,border-color,box-shadow,translate]',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:border-ring',
    'disabled:pointer-events-none disabled:opacity-50',
    // A press should feel like one. Cheap, compositor-friendly, and skipped
    // for anyone who asked for reduced motion.
    'active:translate-y-px motion-reduce:active:translate-y-0',
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        outline:
          'border border-border bg-transparent text-muted-foreground hover:border-primary hover:text-primary',
        outlineDestructive:
          'border border-border bg-transparent text-muted-foreground hover:border-destructive/50 hover:text-destructive',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        ghost: 'bg-transparent hover:bg-accent hover:text-accent-foreground',
        link: 'bg-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-7 px-2.5 text-xs',
        sm: 'h-8 px-3 text-sm',
        default: 'h-9 px-4 text-sm',
        lg: 'h-11 px-5 text-base',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { buttonVariants }
