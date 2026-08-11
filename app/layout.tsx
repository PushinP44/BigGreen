import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Big Green',
  description: 'Personal money tracker. Base currency HKD.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
