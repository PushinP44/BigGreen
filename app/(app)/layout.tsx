import { requireSessionDb } from '@/lib/db/session'
import { countPendingTransactions } from '@/lib/read/ledger'
import { countPendingSuggestions } from '@/lib/read/allocations'
import { AppSidebar } from '@/components/app-sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

export const dynamic = 'force-dynamic'

/**
 * The signed-in shell.
 *
 * A route group — `(app)` contributes nothing to any URL, so every path is
 * unchanged — because the shell needs a session and a database, and `/login`
 * has neither. Putting this in the root layout instead would mean the sign-in
 * page trying to read a session that by definition does not exist yet.
 *
 * The two queue counts are fetched here rather than on the dashboard, which is
 * where they used to live: a badge that only appears on the page you are
 * already looking at is not much of an alert.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { db, email } = await requireSessionDb()
  const [pendingReview, pendingAllocations] = await Promise.all([
    countPendingTransactions(db),
    countPendingSuggestions(db),
  ])

  return (
    // One provider at the root so Radix can share hover timing between
    // triggers, rather than each one running its own open delay.
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-dvh flex-col md:flex-row">
        <AppSidebar
          pendingReview={pendingReview}
          pendingAllocations={pendingAllocations}
          email={email}
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </TooltipProvider>
  )
}
