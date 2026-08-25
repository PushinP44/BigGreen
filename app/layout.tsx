import type { Metadata } from 'next'
import { ThemeProvider } from '@/components/theme-provider'
import './globals.css'

export const metadata: Metadata = {
  title: 'Big Green',
  description: 'Personal money tracker. Base currency HKD.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` is required, not cosmetic: next-themes writes
    // the theme class onto <html> in a pre-paint script, so the server-rendered
    // markup and the first client render legitimately differ on this one
    // element. Without it React logs a hydration error and can discard the
    // class, flashing the wrong theme.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
