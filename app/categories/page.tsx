import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
import {
  averageSpendByCategory,
  hkd,
  spendByCategory,
  type CategoryAverage,
  type CategoryTotal,
} from '@/lib/domain/balances'
import { monthInterval, trailingMonthIntervals } from '@/lib/domain/clock'
import { formatMoney } from '@/lib/domain/money'
import { loadLedgerSnapshot } from '@/lib/read/ledger'

export const dynamic = 'force-dynamic'

const TRAILING_MONTHS = 6

export default async function CategoriesPage() {
  const { db } = await requireSessionDb()
  const { accounts, entries, categories } = await loadLedgerSnapshot(db)

  const now = new Date()
  const thisMonth = spendByCategory(accounts, entries, categories, monthInterval(now))
  const averages = averageSpendByCategory(
    accounts,
    entries,
    categories,
    trailingMonthIntervals(now, TRAILING_MONTHS),
  )
  const rows = mergeRows(thisMonth, averages)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-1">
        <Link
          href="/"
          className="text-xs uppercase tracking-wide text-(--color-muted) hover:text-(--color-green)"
        >
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
        <p className="max-w-2xl text-sm text-(--color-muted)">
          This month against the {TRAILING_MONTHS}-month average — divided over every month,
          not just the ones you spent in, so one big one-off doesn&rsquo;t look like it recurs.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-(--color-muted)">Nothing spent yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-(--color-line) text-left text-xs uppercase tracking-wide text-(--color-muted)">
                <th className="py-2 pr-4 font-medium">Category</th>
                <th className="py-2 pr-4 text-right font-medium">This month</th>
                <th className="py-2 text-right font-medium">{TRAILING_MONTHS}-month average</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.categoryId ?? 'none'} className="border-b border-(--color-line)/60">
                  <td className="py-2 pr-4">{row.name}</td>
                  <td className="tabular py-2 pr-4 text-right">
                    {formatMoney(hkd(row.thisMonthHkdMinor))}
                  </td>
                  <td className="tabular py-2 text-right text-(--color-muted)">
                    {formatMoney(hkd(row.averageHkdMinor))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}

interface CategoryRow {
  readonly categoryId: string | null
  readonly name: string
  readonly thisMonthHkdMinor: bigint
  readonly averageHkdMinor: bigint
}

/** Union of both computations — a category can appear in one and not the other. */
function mergeRows(
  thisMonth: readonly CategoryTotal[],
  averages: readonly CategoryAverage[],
): CategoryRow[] {
  const thisMonthByCategory = new Map(thisMonth.map((row) => [row.categoryId, row]))
  const seen = new Set<string | null>()
  const rows: CategoryRow[] = []

  for (const avg of averages) {
    seen.add(avg.categoryId)
    rows.push({
      categoryId: avg.categoryId,
      name: avg.name,
      thisMonthHkdMinor: thisMonthByCategory.get(avg.categoryId)?.hkdMinor ?? 0n,
      averageHkdMinor: avg.averageHkdMinor,
    })
  }

  for (const [categoryId, row] of thisMonthByCategory) {
    if (seen.has(categoryId)) continue
    rows.push({ categoryId, name: row.name, thisMonthHkdMinor: row.hkdMinor, averageHkdMinor: 0n })
  }

  return rows.sort((a, b) =>
    b.thisMonthHkdMinor > a.thisMonthHkdMinor ? 1 : b.thisMonthHkdMinor < a.thisMonthHkdMinor ? -1 : 0,
  )
}
