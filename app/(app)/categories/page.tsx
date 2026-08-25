import { PageHeader, PageShell, Section } from '@/components/page-shell'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { requireSessionDb } from '@/lib/db/session'
import {
  averageSpendByCategory,
  hkd,
  spendByCategory,
  spendByCategorySeries,
  type CategoryAverage,
  type CategoryPeriodTotals,
  type CategoryTotal,
} from '@/lib/domain/balances'
import { APP_TIMEZONE, monthInterval, trailingMonthIntervals } from '@/lib/domain/clock'
import { formatMoney } from '@/lib/domain/money'
import { loadLedgerSnapshot } from '@/lib/read/ledger'
import { CategoryTrendChart, type CategoryTrendRow } from '@/components/charts/category-trend-chart'

export const dynamic = 'force-dynamic'

const TRAILING_MONTHS = 6
const TOP_CATEGORIES = 5

export default async function CategoriesPage() {
  const { db } = await requireSessionDb()
  const { accounts, entries, categories } = await loadLedgerSnapshot(db)

  const now = new Date()
  const periods = trailingMonthIntervals(now, TRAILING_MONTHS)
  const thisMonth = spendByCategory(accounts, entries, categories, monthInterval(now))
  const averages = averageSpendByCategory(accounts, entries, categories, periods)
  const rows = mergeRows(thisMonth, averages)

  const series = spendByCategorySeries(accounts, entries, categories, periods)
  const topNames = averages
    .filter((a) => a.name !== 'Uncategorised')
    .slice(0, TOP_CATEGORIES)
    .map((a) => a.name)
  const trendData = buildTrendData(series, topNames)

  return (
    <PageShell>
      <PageHeader
        title="Categories"
        description={
          <>
            This month against the {TRAILING_MONTHS}-month average — divided over every month,
            not just the ones you spent in, so one big one-off doesn&rsquo;t look like it recurs.
          </>
        }
      />

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing spent yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">This month</TableHead>
              <TableHead className="text-right">{TRAILING_MONTHS}-month average</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.categoryId ?? 'none'}>
                <TableCell>{row.name}</TableCell>
                <TableCell className="tabular text-right">
                  {formatMoney(hkd(row.thisMonthHkdMinor))}
                </TableCell>
                <TableCell className="tabular text-right text-muted-foreground">
                  {formatMoney(hkd(row.averageHkdMinor))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {topNames.length > 0 ? (
        <Section title={`Trend · top ${TOP_CATEGORIES} categories`}>
          <CategoryTrendChart
            data={trendData}
            categoryKeys={
              trendData.some((row) => 'Other' in row) ? [...topNames, 'Other'] : topNames
            }
          />
        </Section>
      ) : null}
    </PageShell>
  )
}

/**
 * Pivots the per-period series into one row per month, one column per top
 * category plus "Other" — reuses the exact same `spendByCategorySeries` data
 * the table's average is built from, so the chart and the table can never
 * disagree about what happened in any given month.
 */
function buildTrendData(
  series: readonly CategoryPeriodTotals[],
  topNames: readonly string[],
): CategoryTrendRow[] {
  const monthLabel = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIMEZONE, month: 'short' })
  const top = new Set(topNames)

  return series.map(({ period, categories: totals }) => {
    const row: CategoryTrendRow = { label: monthLabel.format(period.start) }
    let other = 0n

    for (const total of totals) {
      if (top.has(total.name)) {
        row[total.name] = Number(total.hkdMinor) / 100
      } else {
        other += total.hkdMinor
      }
    }
    if (other > 0n) row.Other = Number(other) / 100

    return row
  })
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
