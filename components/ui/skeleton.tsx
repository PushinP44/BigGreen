import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Loading placeholder for the Suspense boundaries the redesign introduces.
 *
 * Deliberately no shimmer sweep — a pulsing block is enough, and a money page
 * full of travelling gradients reads as busier than the data it is standing in
 * for. Users who asked for reduced motion get a static block.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  )
}
