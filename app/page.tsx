import Link from 'next/link'
import { getDb } from '@/lib/db/client'
import {
  accountBalances,
  currencyPools,
  discretionarySpentInInterval,
  hkd,
  incomeInInterval,
  ledgerIsBalanced,
  spendByCategory,
  spentInInterval,
  type CurrencyPool,
} from '@/lib/domain/balances'
import { APP_TIMEZONE, monthInterval, toLocalDate, zonedParts } from '@/lib/domain/clock'
import { formatMoney, money, type Currency } from '@/lib/domain/money'
import { safetyTerms, termsToJson, type PoolTerms } from '@/lib/domain/safety'
import {
  loadLedgerSnapshot,
  listCategories,
  listFxStatus,
  listRecentTransactions,
} from '@/lib/read/ledger'
import { rateTableFor } from '@/lib/read/accounts'
import { loadSafetySettings } from '@/lib/read/settings'
import { EntryForm } from './entry-form'
import { RefreshRates } from './refresh-rates'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const db = await getDb()

  const [snapshot, transactions, fxStatus, categories, rates, { settings }] = await Promise.all([
    loadLedgerSnapshot(db),
    listRecentTransactions(db, 20),
    listFxStatus(db),
    listCategories(db),
    rateTableFor(db),
    loadSafetySettings(db),
  ])

  // Explicit `now`, threaded into every date decision. Domain functions never
  // read the clock themselves — that is what makes them testable (PLAN D4).
  const now = new Date()
  const thisMonth = monthInterval(now)

  const { accounts, entries } = snapshot
  const balances = accountBalances(accounts, entries)
  const pools = currencyPools(accounts, balances)
  const spent = spentInInterval(accounts, entries, thisMonth)
  const income = incomeInInterval(accounts, entries, thisMonth)
  const discretionary = discretionarySpentInInterval(
    accounts,
    entries,
    snapshot.categories,
    thisMonth,
  )
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
    (await db.query<{ id: string; name: string }>('SELECT id, name FROM accounts')).rows.map(
      (r) => [r.id, r.name],
    ),
  )

  const ownAccounts = accounts.filter((a) => a.isOwn)
  const monthLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    month: 'long',
    year: 'numeric',
  }).format(now)

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Big Green</h1>
          <p className="text-sm text-(--color-muted)">
            {monthLabel} · {APP_TIMEZONE}
          </p>
        </div>
        <nav className="flex items-center gap-2">
          <Link href="/settings" className={chip}>
            Settings
          </Link>
          <a href="/api/export?format=csv" className={chip}>
            Export
          </a>
        </nav>
      </header>

      {!balanced ? (
        <p
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          The ledger does not sum to zero. Something bypassed the double-entry constraint — do not
          trust any figure on this page until it is resolved.
        </p>
      ) : null}

      {/*
        One card per currency, never a blended total. Baht in a Thai bank cannot
        buy lunch in Hong Kong, and a single number would claim otherwise
        (PLAN rev 4).
      */}
      <section className="flex flex-col gap-3">
        <h2 className={sectionHeading}>Safe to spend today</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {terms.pools.map((pool) => (
            <PoolCard
              key={pool.currency}
              pool={pool}
              worth={pools.find((p) => p.currency === pool.currency)}
            />
          ))}
        </div>
        <p className="text-xs text-(--color-muted)">
          Held separately on purpose — each pool is judged against the money that can actually pay
          for something in it. Investments are not included until P4.
        </p>
      </section>

      {/*
        Flow, not liquidity. These three are blended across pools and converted
        to HKD on purpose — they answer "how did the month go", which is a
        question about behaviour, unlike the pool cards above which answer "what
        can I actually spend". Every figure here says HKD so the difference is
        never mistaken for an inconsistency.
      */}
      <section className="flex flex-col gap-4">
        <h2 className={sectionHeading}>This month · all pools, in HKD</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Spent" value={formatMoney(hkd(spent))} />
          <Stat label="Income" value={formatMoney(hkd(income))} />
          <Stat
            label="Discretionary"
            value={`${formatMoney(hkd(discretionary), { showSymbol: false })} / ${formatMoney(hkd(terms.discretionaryBudgetHkdMinor), { showSymbol: false })}`}
            emphasis={discretionary > terms.discretionaryBudgetHkdMinor ? 'over' : 'normal'}
          />
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-(--color-line)">
          <div
            className={`h-full rounded-full ${
              discretionary > terms.discretionaryBudgetHkdMinor ? 'bg-red-500' : 'bg-(--color-green)'
            }`}
            style={{ width: `${percent(discretionary, terms.discretionaryBudgetHkdMinor)}%` }}
          />
        </div>

        {byCategory.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {byCategory.slice(0, 6).map((row) => (
              <li key={row.categoryId ?? 'none'} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-(--color-muted)">{row.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--color-line)">
                  <span
                    className="block h-full rounded-full bg-(--color-green)/70"
                    style={{ width: `${percent(row.hkdMinor, byCategory[0]?.hkdMinor ?? 1n)}%` }}
                  />
                </span>
                <span className="tabular w-24 text-right">{formatMoney(hkd(row.hkdMinor))}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-(--color-muted)">Nothing spent this month yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className={sectionHeading}>Record a transaction</h2>
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
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={sectionHeading}>Accounts</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-(--color-line) text-left text-xs uppercase tracking-wide text-(--color-muted)">
                <th className="py-2 pr-4 font-medium">Account</th>
                <th className="py-2 pr-4 font-medium">Kind</th>
                <th className="py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {ownAccounts.map((account) => (
                <tr key={account.id} className="border-b border-(--color-line)/60">
                  <td className="py-2 pr-4">
                    {accountNames.get(account.id)}
                    {account.isLiquid ? (
                      <span className="ml-2 rounded bg-(--color-green)/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-(--color-green)">
                        liquid
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 text-(--color-muted)">{account.kind}</td>
                  <td className="tabular py-2 text-right">
                    {formatMoney(
                      money(balances.get(account.id)?.nativeMinor ?? 0n, account.currency),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={sectionHeading}>Recent</h2>
        {transactions.length === 0 ? (
          <p className="text-sm text-(--color-muted)">No transactions yet.</p>
        ) : (
          <ul className="flex flex-col">
            {transactions.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline gap-3 border-b border-(--color-line)/60 py-2 text-sm"
              >
                <span className="tabular w-16 shrink-0 text-xs text-(--color-muted)">
                  {shortDate(row.occurredAt)}
                </span>
                <span className="flex-1 truncate">
                  {row.description || <span className="text-(--color-muted)">No description</span>}
                  {row.isTransfer ? (
                    <span className="ml-2 rounded bg-(--color-line) px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-(--color-muted)">
                      transfer
                    </span>
                  ) : null}
                </span>
                <span className="hidden w-28 shrink-0 truncate text-xs text-(--color-muted) sm:block">
                  {row.categoryName ?? ''}
                </span>
                <span className="hidden w-32 shrink-0 truncate text-xs text-(--color-muted) sm:block">
                  {row.accountName}
                </span>
                <span
                  className={`tabular w-28 shrink-0 text-right ${
                    row.ownedDeltaHkdMinor > 0n ? 'text-(--color-green)' : ''
                  }`}
                >
                  {formatMoney(money(row.nativeMinor, row.accountCurrency as Currency))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={sectionHeading}>Exchange rates</h2>
        <p className="text-xs text-(--color-muted)">
          Used for cross-currency transfers and the approximate totals above — never for a headline
          figure.
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {fxStatus.length === 0 ? (
            <span className="text-(--color-muted)">No rates stored yet.</span>
          ) : (
            fxStatus.map((rate) => (
              <span key={rate.currency} className="flex items-baseline gap-2">
                <span className="text-(--color-muted)">{rate.currency}/HKD</span>
                <span className="tabular">{Number(rate.rate).toFixed(5)}</span>
                <span className="text-xs text-(--color-muted)">
                  {rate.asOf} · {rate.source}
                  {staleness(rate.asOf, now)}
                </span>
              </span>
            ))
          )}
        </div>
        <RefreshRates />
      </section>
    </main>
  )
}

const sectionHeading = 'text-sm font-medium uppercase tracking-wide text-(--color-muted)'
const chip =
  'rounded-md border border-(--color-line) px-3 py-1.5 text-xs uppercase tracking-wide text-(--color-muted) transition hover:border-(--color-green) hover:text-(--color-green)'

/**
 * One currency pool. Shows the terms that produced the headline, because
 * consistency between the number and the numbers under it is what makes the
 * number believable (PLAN §5, §6).
 */
function PoolCard({ pool, worth }: { pool: PoolTerms; worth: CurrencyPool | undefined }) {
  const negative = pool.availableMinor < 0n
  const amount = (minor: bigint) => formatMoney(money(minor, pool.currency))

  return (
    <div
      className={`flex flex-col gap-2 rounded-xl border p-5 ${
        negative ? 'border-red-500/40 bg-red-500/5' : 'border-(--color-green)/40 bg-(--color-green)/5'
      }`}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-(--color-muted)">
          {pool.currency}
        </span>
        {pool.runwayDays !== null ? (
          <span className="text-xs text-(--color-muted)">
            {Math.floor(pool.runwayDays)}d cover
          </span>
        ) : null}
      </div>

      <span
        className={`tabular text-2xl font-semibold ${negative ? 'text-red-600 dark:text-red-400' : ''}`}
      >
        {amount(pool.availableMinor)}
      </span>

      <dl className="flex flex-col gap-0.5 text-xs text-(--color-muted)">
        <Term label="Liquid" value={amount(pool.liquidMinor)} />
        {pool.committedMinor > 0n ? (
          <Term label="Committed" value={`− ${amount(pool.committedMinor)}`} />
        ) : null}
        {pool.floorMinor > 0n ? (
          <Term label={`Floor (${pool.floorDays}d)`} value={`− ${amount(pool.floorMinor)}`} />
        ) : (
          <div className="pt-0.5 italic">No floor set — this is a balance, not a cushion.</div>
        )}
        {worth && worth.currency !== 'HKD' ? (
          <Term label="≈ HKD" value={formatMoney(hkd(worth.totalHkdMinor))} />
        ) : null}
      </dl>

      {pool.burnSource !== 'none' ? (
        <span className="text-[10px] uppercase tracking-wide text-(--color-muted)">
          burn: {pool.burnSource}
          {pool.burnSource === 'declared' ? ' (not enough history yet)' : ''}
        </span>
      ) : null}
    </div>
  )
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  )
}

function Stat({
  label,
  value,
  emphasis = 'normal',
}: {
  label: string
  value: string
  emphasis?: 'normal' | 'over'
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-(--color-muted)">{label}</span>
      <span
        className={`tabular text-xl font-medium ${
          emphasis === 'over' ? 'text-red-600 dark:text-red-400' : ''
        }`}
      >
        {value}
      </span>
    </div>
  )
}

function percent(value: bigint, total: bigint): number {
  if (total <= 0n) return 0
  const raw = Number((value * 1000n) / total) / 10
  return Math.max(0, Math.min(100, raw))
}

function shortDate(date: Date): string {
  const parts = zonedParts(date)
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}`
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
