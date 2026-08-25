'use client'

import * as SeparatorPrimitive from '@radix-ui/react-separator'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Replaces the `border-t border-border pt-8` section divider repeated across 8
 * places. Radix's version is used rather than a bare `<hr>` because it defaults
 * to `decorative`, which keeps a purely visual rule out of the accessibility
 * tree instead of announcing a separator between every section.
 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}
