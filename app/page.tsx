import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
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
import type { CardPosition } from '@/lib/domain/credit'
import {
  loadLedgerSnapshot,
  listCategories,
  listFxStatus,
  listRecentTransactions,
} from '@/lib/read/ledger'
import { rateTableFor } from '@/lib/read/accounts'
import { loadSafetySettings } from '@/lib/read/settings'
import { listIngestHeartbeats } from '@/lib/read/ingest-sources'
import {
  heartbeatStatus,
  type HeartbeatStatus,
  type IngestHeartbeatSnapshot,
} from '@/lib/domain/ingest-health'
import { FX_SOURCE_KEY } from '@/lib/fx/frankfurter'
import { PRICES_SOURCE_KEY } from '@/lib/fx/finnhub'
import { loadHoldings, type PricedHolding } from '@/lib/read/holdings'
import { countPendingSuggestions } from '@/lib/read/allocations'
import { EntryForm } from './entry-form'
import { RefreshRates } from './refresh-rates'
import { RefreshPrices } from './refresh-prices'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const { db, email } = await requireSessionDb()

  // Explicit `now`, threaded into every date decision. Domain functions never
  // read the clock themselves — that is what makes them testable (PLAN D4).
  const now = new Date()

  const [
    snapshot,
    transactions,
    fxStatus,
    categories,
    rates,
    { settings },
    heartbeats,
    holdings,
    pendingAllocations,
  ] = await Promise.all([
    loadLedgerSnapshot(db),
    listRecentTransactions(db, 20),
    listFxStatus(db),
    listCategories(db),
    rateTableFor(db),
    loadSafetySettings(db),
    listIngestHeartbeats(db),
    loadHoldings(db, now),
    countPendingSuggestions(db),
  ])

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

  // Emails the parser was not confident enough to post. An unbounded queue
  // means a parser is broken, so it belongs where you cannot miss it.
  const pendingCount = Number(
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM transactions WHERE status = 'pending'`,
      )
    ).rows[0]?.n ?? 0,
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
          {pendingCount > 0 ? (
            <Link
              href="/review"
              className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs uppercase tracking-wide text-amber-600 transition hover:border-amber-500 dark:text-amber-400"
            >
              {pendingCount} to review
            </Link>
          ) : null}
          {pendingAllocations > 0 ? (
            <Link
              href="/allocations"
              className="rounded-md border border-(--color-green)/50 bg-(--color-green)/10 px-3 py-1.5 text-xs uppercase tracking-wide text-(--color-green) transition hover:border-(--color-green)"
            >
              {pendingAllocations} to allocate
            </Link>
          ) : null}
          <Link href="/accounts" className={chip}>
            Accounts
          </Link>
          <Link href="/categories" className={chip}>
            Categories
          </Link>
          <Link href="/portfolio" className={chip}>
            Portfolio
          </Link>
          <Link href="/settings" className={chip}>
            Settings
          </Link>
          <a href="/api/export?format=csv" className={chip}>
            Export
          </a>
          {email ? (
            <form action="/logout" method="post">
              <button type="submit" className={chip} title={email}>
                Sign out
              </button>
            </form>
          ) : null}
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
          for something in it. Investments have their own section below and are deliberately
          excluded here — a position is not spendable liquidity.
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
        {ownAccounts.length === 0 ? (
          <p className="rounded-lg border border-(--color-line) px-4 py-6 text-sm text-(--color-muted)">
            No accounts yet, so there is nowhere to record a transaction.{' '}
            <Link href="/accounts" className="text-(--color-green) underline">
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
        <h2 className={sectionHeading}>Holdings</h2>
        {holdings.length === 0 ? (
          <p className="text-sm text-(--color-muted)">No positions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-(--color-line) text-left text-xs uppercase tracking-wide text-(--color-muted)">
                  <th className="py-2 pr-4 font-medium">Symbol</th>
                  <th className="py-2 pr-4 text-right font-medium">Quantity</th>
                  <th className="py-2 pr-4 text-right font-medium">Avg cost</th>
                  <th className="py-2 pr-4 text-right font-medium">Last price</th>
                  <th className="py-2 pr-4 text-right font-medium">Value</th>
                  <th className="py-2 text-right font-medium">Unrealised P/L</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => (
                  <HoldingRow key={holding.instrumentId} holding={holding} />
                ))}
              </tbody>
            </table>
            <p className="pt-2 text-xs text-(--color-muted)">
              P/L totals exclude <span className="whitespace-nowrap">COST UNKNOWN</span> positions
              — a fabricated gain is worse than an honest blank.
            </p>
          </div>
        )}
        <RefreshPrices />
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

        {/*
          Written since the FX job existed, never shown until now — a dead
          feed and a quiet market look identical without this (PLAN §6.7).
          Visible on load, not only after clicking Refresh rates.
        */}
        {heartbeats.length > 0 ? (
          <div className="flex flex-col gap-1.5 border-t border-(--color-line) pt-3 text-xs text-(--color-muted)">
            <span className="uppercase tracking-wide">Data health</span>
            {heartbeats.map((heartbeat) => (
              <div key={heartbeat.sourceKey} className="flex items-center gap-2">
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${HEALTH_COLOR[heartbeatStatus(heartbeat, now)]}`}
                  aria-hidden
                />
                <span>{sourceLabel(heartbeat.sourceKey)}</span>
                <span>{healthSummary(heartbeat, now)}</span>
              </div>
            ))}
          </div>
        ) : null}
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

      {pool.cards.map((card) => (
        <CardPanel key={card.accountId} card={card} currency={pool.currency} />
      ))}
    </div>
  )
}

/**
 * The card, split into what it actually is: a payment due soon, and debt.
 *
 * Showing the balance alone hides both halves — you cannot see what is
 * genuinely due next, and you cannot see what carrying the rest costs. The
 * interest figure is the number that makes carrying a balance a visible choice
 * rather than something discovered on a statement.
 */
function CardPanel({ card, currency }: { card: CardPosition; currency: Currency }) {
  const amount = (minor: bigint) => formatMoney(money(minor, currency))
  if (card.owedMinor === 0n) return null

  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-(--color-line) pt-2 text-xs text-(--color-muted)">
      <div className="flex items-baseline justify-between gap-3">
        <span className="uppercase tracking-wide">Card owed</span>
        <span className="tabular">{amount(card.owedMinor)}</span>
      </div>
      <Term
        label={`Due ${shortDate(card.cycle.dueAt)}${card.dueWithinHorizon ? '' : ' (past horizon)'}`}
        value={amount(card.minimumPaymentMinor)}
      />
      {card.unbilledMinor > 0n ? (
        <Term label="Since statement" value={amount(card.unbilledMinor)} />
      ) : null}
      {card.estimatedMonthlyInterestMinor !== null &&
      card.estimatedMonthlyInterestMinor > 0n ? (
        <div className="flex items-baseline justify-between gap-3 text-amber-600 dark:text-amber-400">
          <dt>Interest ≈ /month</dt>
          <dd className="tabular">{amount(card.estimatedMonthlyInterestMinor)}</dd>
        </div>
      ) : null}
      {card.availableCreditMinor !== null ? (
        <Term label="Credit left" value={amount(card.availableCreditMinor)} />
      ) : null}
    </div>
  )
}

/** Trims a fixed-point decimal string's trailing zeros for display: "10.0000000000" → "10". */
function formatQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity
  return quantity.replace(/0+$/, '').replace(/\.$/, '')
}

function HoldingRow({ holding }: { holding: PricedHolding }) {
  const currency = holding.currency as Currency
  const amount = (minor: bigint) => formatMoney(money(minor, currency))
  const stale = holding.staleDays !== null && holding.staleDays > 7

  return (
    <tr className="border-b border-(--color-line)/60">
      <td className="py-2 pr-4">
        {holding.symbol}
        {stale ? (
          <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
            {holding.staleDays}d old
          </span>
        ) : null}
      </td>
      <td className="tabular py-2 pr-4 text-right text-(--color-muted)">
        {formatQuantity(holding.quantity)}
      </td>
      <td className="tabular py-2 pr-4 text-right">
        {holding.avgCostMinor === null ? (
          <span className="text-(--color-muted)">COST UNKNOWN</span>
        ) : (
          amount(holding.avgCostMinor)
        )}
      </td>
      <td className="tabular py-2 pr-4 text-right">
        {holding.priceMinor === null ? '—' : amount(holding.priceMinor)}
      </td>
      <td className="tabular py-2 pr-4 text-right">
        {holding.marketValueMinor === null ? '—' : amount(holding.marketValueMinor)}
      </td>
      <td
        className={`tabular py-2 text-right ${
          holding.unrealizedPlMinor === null
            ? ''
            : holding.unrealizedPlMinor >= 0n
              ? 'text-(--color-green)'
              : 'text-red-600 dark:text-red-400'
        }`}
      >
        {holding.unrealizedPlMinor === null ? '—' : amount(holding.unrealizedPlMinor)}
      </td>
    </tr>
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

const HEALTH_COLOR: Record<HeartbeatStatus, string> = {
  ok: 'bg-(--color-green)',
  never_run: 'bg-(--color-muted)',
  stale: 'bg-amber-500',
  failing: 'bg-red-500',
}

function sourceLabel(sourceKey: string): string {
  if (sourceKey === FX_SOURCE_KEY) return 'Exchange rates'
  if (sourceKey === PRICES_SOURCE_KEY) return 'Live prices'
  return sourceKey
}

function healthSummary(heartbeat: IngestHeartbeatSnapshot, now: Date): string {
  const status = heartbeatStatus(heartbeat, now)
  if (status === 'failing') {
    return `failing — ${heartbeat.consecutiveFailures}× in a row`
  }
  if (heartbeat.lastSuccessAt === null) return 'never run'
  const summary = `last succeeded ${shortDate(heartbeat.lastSuccessAt)}`
  return status === 'stale' ? `${summary} — overdue` : summary
}
