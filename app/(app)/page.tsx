import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
import {
  accountBalances,
  currencyPools,
  currencyPoolsSeries,
  discretionarySpentInInterval,
  hkd,
  incomeInInterval,
  ledgerIsBalanced,
  minorFactor,
  spendByCategory,
  spentInInterval,
} from '@/lib/domain/balances'
import { APP_TIMEZONE, addDays, monthInterval, toLocalDate } from '@/lib/domain/clock'
import { formatMoney, money, toHkdMinor, type Currency } from '@/lib/domain/money'
import { safetyTerms, termsToJson } from '@/lib/domain/safety'
import {
  loadLedgerSnapshot,
  listCategories,
  listFxStatus,
  listRecentTransactions,
} from '@/lib/read/ledger'
import { rateTableFor } from '@/lib/read/accounts'
import { loadSafetySettings } from '@/lib/read/settings'
import { listIngestHeartbeats } from '@/lib/read/ingest-sources'
import { loadHoldings } from '@/lib/read/holdings'
import { percentOf, shortDate } from '@/lib/format'
import { NetWorthChart, type NetWorthPoint } from '@/components/charts/net-worth-chart'
import { TopHoldingsChart, type TopHoldingPoint } from '@/components/charts/top-holdings-chart'
import { TopMoversChart, type MoverPoint } from '@/components/charts/top-movers-chart'
import { DataHealth } from '@/components/dashboard/data-health'
import { PoolCard } from '@/components/dashboard/pool-card'
import { Stat } from '@/components/dashboard/stat'
import { EntryForm } from '@/components/entry-form'
import { PageHeader, PageShell, Section, SectionHeading } from '@/components/page-shell'
import { RefreshButton } from '@/components/refresh-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

const TOP_N = 3
const NET_WORTH_WEEKS = 26

export const dynamic = 'force-dynamic'

export default async function Home() {
  const { db } = await requireSessionDb()

  // Explicit `now`, threaded into every date decision. Domain functions never
  // read the clock themselves — that is what makes them testable (PLAN D4).
  const now = new Date()

  const [snapshot, transactions, fxStatus, categories, rates, { settings }, heartbeats, holdings] =
    await Promise.all([
      loadLedgerSnapshot(db),
      listRecentTransactions(db, 20),
      listFxStatus(db),
      listCategories(db),
      rateTableFor(db),
      loadSafetySettings(db),
      listIngestHeartbeats(db),
      loadHoldings(db, now),
    ])

  const thisMonth = monthInterval(now)

  const { accounts, entries } = snapshot
  const balances = accountBalances(accounts, entries)
  const pools = currencyPools(accounts, balances)

  // Oldest first, so the chart reads left-to-right chronologically.
  const netWorthBoundaries = Array.from({ length: NET_WORTH_WEEKS }, (_, i) =>
    addDays(now, -7 * (NET_WORTH_WEEKS - 1 - i)),
  )
  const netWorthData: NetWorthPoint[] = currencyPoolsSeries(
    accounts,
    entries,
    netWorthBoundaries,
  ).map((point) => {
    const byCurrency = new Map(point.pools.map((p) => [p.currency, p]))
    const majorUnits = (currency: Currency) => {
      const total = byCurrency.get(currency)?.totalMinor ?? 0n
      return Number(total) / Number(minorFactor(currency))
    }
    return {
      label: shortDate(point.asOf),
      HKD: majorUnits('HKD'),
      USD: majorUnits('USD'),
      THB: majorUnits('THB'),
    }
  })

  const spent = spentInInterval(accounts, entries, thisMonth)
  const income = incomeInInterval(accounts, entries, thisMonth)
  const discretionary = discretionarySpentInInterval(accounts, entries, snapshot.categories, thisMonth)
  const byCategory = spendByCategory(accounts, entries, snapshot.categories, thisMonth)
  const balanced = ledgerIsBalanced(entries)

  const terms = safetyTerms({
    accounts,
    entries,
    categories: snapshot.categories,
    settings,
    now,
  })

  const accountNames = new Map(
    (await db.query<{ id: string; name: string }>('SELECT id, name FROM accounts')).rows.map((r) => [
      r.id,
      r.name,
    ]),
  )

  // Blended to HKD only for ranking across currencies — same one-time
  // exception as the portfolio page's allocation breakdown (PLAN rev 4
  // otherwise keeps pools and the net-worth chart above unblended).
  const pricedHoldings = holdings
    .map((h) => ({
      holding: h,
      valueHkdMinor:
        h.marketValueMinor === null ? null : toHkdMinor(h.marketValueMinor, h.currency, rates),
    }))
    .filter(
      (h): h is { holding: (typeof holdings)[number]; valueHkdMinor: bigint } =>
        h.valueHkdMinor !== null,
    )

  const topHoldings: TopHoldingPoint[] = [...pricedHoldings]
    .sort((a, b) => (b.valueHkdMinor > a.valueHkdMinor ? 1 : b.valueHkdMinor < a.valueHkdMinor ? -1 : 0))
    .slice(0, TOP_N)
    .map((h) => ({
      label: h.holding.symbol,
      valueHkd: Number(h.valueHkdMinor) / Number(minorFactor('HKD')),
    }))

  const priced = holdings.filter((h) => h.unrealizedPlPercent !== null)
  const gainers = [...priced]
    .filter((h) => h.unrealizedPlPercent! >= 0)
    .sort((a, b) => b.unrealizedPlPercent! - a.unrealizedPlPercent!)
    .slice(0, TOP_N)
  const losers = [...priced]
    .filter((h) => h.unrealizedPlPercent! < 0)
    .sort((a, b) => a.unrealizedPlPercent! - b.unrealizedPlPercent!)
    .slice(0, TOP_N)
  const topMovers: MoverPoint[] = [...losers, ...gainers]
    .sort((a, b) => a.unrealizedPlPercent! - b.unrealizedPlPercent!)
    .map((h) => ({ label: h.symbol, percent: h.unrealizedPlPercent! }))

  const ownAccounts = accounts.filter((a) => a.isOwn)
  const overBudget = discretionary > terms.discretionaryBudgetHkdMinor
  const monthLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    month: 'long',
    year: 'numeric',
  }).format(now)

  return (
    <PageShell>
      <PageHeader title="Big Green" description={`${monthLabel} · ${APP_TIMEZONE}`} />

      {!balanced ? (
        <Alert variant="destructive">
          The ledger does not sum to zero. Something bypassed the double-entry constraint — do not
          trust any figure on this page until it is resolved.
        </Alert>
      ) : null}

      {/*
        One card per currency, never a blended total. Baht in a Thai bank cannot
        buy lunch in Hong Kong, and a single number would claim otherwise
        (PLAN rev 4).
      */}
      <Section
        title="Safe to spend today"
        description="Held separately on purpose — each pool is judged against the money that can actually pay for something in it. Investments have their own section below and are deliberately excluded: a position is not spendable liquidity."
        divided={false}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {terms.pools.map((pool) => (
            <PoolCard
              key={pool.currency}
              pool={pool}
              worth={pools.find((p) => p.currency === pool.currency)}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Net worth over time · per pool"
        description="26 weeks, at cost — holdings count at what you paid, not today’s market price. A true mark-to-market history needs a price as of every past week, not just the latest one; that’s a bigger lift than this chart is."
      >
        <NetWorthChart data={netWorthData} />
      </Section>

      {/*
        Flow, not liquidity. These three are blended across pools and converted
        to HKD on purpose — they answer "how did the month go", which is a
        question about behaviour, unlike the pool cards above which answer "what
        can I actually spend". Every figure here says HKD so the difference is
        never mistaken for an inconsistency.
      */}
      <Section title="This month · all pools, in HKD">
        <div className="grid gap-6 sm:grid-cols-3">
          <Stat label="Spent" value={formatMoney(hkd(spent))} />
          <Stat label="Income" value={formatMoney(hkd(income))} />
          <Stat
            label="Discretionary"
            value={`${formatMoney(hkd(discretionary), { showSymbol: false })} / ${formatMoney(hkd(terms.discretionaryBudgetHkdMinor), { showSymbol: false })}`}
            emphasis={overBudget ? 'over' : 'normal'}
          />
        </div>

        <Progress
          value={percentOf(discretionary, terms.discretionaryBudgetHkdMinor)}
          indicatorClassName={overBudget ? 'bg-destructive' : undefined}
        />

        {byCategory.length > 0 ? (
          <ul className="flex flex-col gap-2 text-sm">
            {byCategory.slice(0, 6).map((row) => (
              <li key={row.categoryId ?? 'none'} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-muted-foreground">{row.name}</span>
                <Progress
                  size="sm"
                  className="flex-1"
                  indicatorClassName="bg-primary/70"
                  value={percentOf(row.hkdMinor, byCategory[0]?.hkdMinor ?? 1n)}
                />
                <span className="tabular w-24 text-right">{formatMoney(hkd(row.hkdMinor))}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing spent this month yet.</p>
        )}
      </Section>

      <Section title="Record a transaction">
        {ownAccounts.length === 0 ? (
          <p className="rounded-lg border border-border px-4 py-6 text-sm text-muted-foreground">
            No accounts yet, so there is nowhere to record a transaction.{' '}
            <Link href="/accounts" className="text-primary underline underline-offset-4">
              Add your first account
            </Link>{' '}
            to get started.
          </p>
        ) : (
          <EntryForm
            accounts={ownAccounts.map((a) => ({
              id: a.id,
              name: accountNames.get(a.id) ?? a.id,
              currency: a.currency,
            }))}
            categories={categories.map((c) => ({
              id: c.id,
              name: c.name,
              isDiscretionary: c.isDiscretionary,
            }))}
            terms={termsToJson(terms)}
            rates={rates}
          />
        )}
      </Section>

      <Section title="Accounts">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ownAccounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    {accountNames.get(account.id)}
                    {account.isLiquid ? <Badge variant="success">liquid</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{account.kind}</TableCell>
                <TableCell className="tabular text-right">
                  {formatMoney(money(balances.get(account.id)?.nativeMinor ?? 0n, account.currency))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="Holdings"
        actions={
          <Link
            href="/portfolio"
            className="text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            Full breakdown →
          </Link>
        }
      >
        {holdings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No positions yet.</p>
        ) : pricedHoldings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No live prices yet — refresh prices to see your top holdings and movers.
          </p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <SectionHeading>Top {TOP_N} by value</SectionHeading>
              <TopHoldingsChart data={topHoldings} />
            </div>
            <div className="flex flex-col gap-2">
              <SectionHeading>Top movers</SectionHeading>
              {topMovers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing priced enough to compare yet.</p>
              ) : (
                <TopMoversChart data={topMovers} />
              )}
            </div>
          </div>
        )}
        <RefreshButton source="prices" />
      </Section>

      <Section title="Recent">
        {transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions yet.</p>
        ) : (
          <ul className="flex flex-col">
            {transactions.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline gap-3 border-b border-border/60 py-2 text-sm last:border-b-0"
              >
                <span className="tabular w-12 shrink-0 text-xs text-muted-foreground">
                  {shortDate(row.occurredAt)}
                </span>
                <span className="flex-1 truncate">
                  {row.description || <span className="text-muted-foreground">No description</span>}
                  {row.isTransfer ? <Badge className="ml-2">transfer</Badge> : null}
                </span>
                <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground sm:block">
                  {row.categoryName ?? ''}
                </span>
                <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground sm:block">
                  {row.accountName}
                </span>
                <span
                  className={cn(
                    'tabular w-28 shrink-0 text-right',
                    row.ownedDeltaHkdMinor > 0n && 'text-primary',
                  )}
                >
                  {formatMoney(money(row.nativeMinor, row.accountCurrency as Currency))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Exchange rates"
        description="Used for cross-currency transfers and the approximate totals above — never for a headline figure."
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {fxStatus.length === 0 ? (
            <span className="text-muted-foreground">No rates stored yet.</span>
          ) : (
            fxStatus.map((rate) => (
              <span key={rate.currency} className="flex items-baseline gap-2">
                <span className="text-muted-foreground">{rate.currency}/HKD</span>
                <span className="tabular">{Number(rate.rate).toFixed(5)}</span>
                <span className="text-xs text-muted-foreground">
                  {rate.asOf} · {rate.source}
                  {staleness(rate.asOf, now)}
                </span>
              </span>
            ))
          )}
        </div>
        <RefreshButton source="rates" />
        <DataHealth heartbeats={heartbeats} now={now} />
      </Section>
    </PageShell>
  )
}

/**
 * ECB publishes on business days only, so a day or two old is normal. Past a
 * week the rate is stale enough that showing it bare would mislead (PLAN §6.7).
 */
function staleness(asOf: string, now: Date): string {
  const days = Math.round(
    (Date.parse(`${toLocalDate(now)}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000,
  )
  return days > 7 ? ` · ${days}d old` : ''
}
