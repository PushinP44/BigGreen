import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
import { listPendingSuggestions } from '@/lib/read/allocations'
import { listAccountBalances } from '@/lib/read/accounts'
import { SuggestionRow } from './suggestion-row'

export const dynamic = 'force-dynamic'

export default async function AllocationsPage() {
  const { db } = await requireSessionDb()
  const [suggestions, accounts] = await Promise.all([
    listPendingSuggestions(db),
    listAccountBalances(db),
  ])

  const destinations = accounts.filter((a) => a.isOwn)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-1">
        <Link
          href="/"
          className="text-xs uppercase tracking-wide text-muted-foreground hover:text-(--color-green)"
        >
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Allocation suggestions</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every external inflow of 2,000 HKD or more suggests moving 30% somewhere other than
          spending — PLAN §8. Accepting schedules a transfer you still have to actually make;
          dismissing needs a reason, because a suggestion you never act on is worse than none.
        </p>
      </header>

      {suggestions.length === 0 ? (
        <p className="rounded-lg border border-(--color-line) px-4 py-6 text-sm text-muted-foreground">
          Nothing pending. A qualifying inflow shows up here automatically.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {suggestions.map((suggestion) => (
            <SuggestionRow key={suggestion.id} suggestion={suggestion} accounts={destinations} />
          ))}
        </ul>
      )}
    </main>
  )
}
