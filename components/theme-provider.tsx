'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ComponentProps } from 'react'

/**
 * Thin client wrapper so `app/layout.tsx` can stay a Server Component.
 *
 * Theming moved from a `prefers-color-scheme` media query to a class on
 * `<html>` because the media query cannot express "the user wants dark even
 * though the OS says light". `defaultTheme="system"` keeps the previous
 * behaviour as the default — nothing changes until someone picks a side.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
