import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
import { listAccountBalances, rateTableFor } from '@/lib/read/accounts'
import { loadHoldings, listRecentPositions } from '@/lib/read/holdings'
import { computeAllocations } from '@/lib/domain/holdings'
import { zonedParts } from '@/lib/domain/clock'
import { formatMoney, money, toDecimalString, toHkdMinor } from '@/lib/domain/money'
import { HoldingsTable, formatQuantity } from '../holdings-table'
import { AllocationBreakdown, type AllocationRow } from './allocation'
import { InstrumentForm } from './instrument-form'
import { PositionForm, type EditingPosition } from './position-form'
import { RecentPositions, type RecentPositionRow } from './recent-positions'
import { WeightInput } from './weight-input'

function absMinor(amountMinor: bigint): bigint {
  return amountMinor < 0n ? -amountMinor : amountMinor
}

function shortDate(date: Date): string {
  const parts = zonedParts(date)
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}`
}

export const dynamic = 'force-dynamic'

interface InstrumentRow {
  id: string
  symbol: string
  kind: string
  currency: string
  target_weight_bps: number | null
}

function bpsToPercentString(bps: number | null): string {
  if (bps === null) return ''
  return (bps / 100).toString()
}

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>
}) {
  const { db } = await requireSessionDb()
  const editingId = (await searchParams).edit

  // Explicit `now`, threaded into every date decision — domain functions
  // never read the clock themselves (PLAN D4).
  const now = new Date()

  const [instrumentRows, accounts, holdings, rates, recentPositions] = await Promise.all([
    db.query<InstrumentRow>(
      `SELECT id, symbol, kind::text AS kind, currency, target_weight_bps
         FROM instruments ORDER BY symbol`,
    ),
    listAccountBalances(db),
    loadHoldings(db, now),
    rateTableFor(db),
    listRecentPositions(db),
  ])

  const instruments = instrumentRows.rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    kind: row.kind,
    currency: row.currency.trim(),
    targetWeightBps: row.target_weight_bps,
  }))

  const ownAccounts = accounts
    .filter((a) => a.isOwn)
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency }))

  const totalWeightPercent =
    instruments.reduce((sum, i) => sum + (i.targetWeightBps ?? 0), 0) / 100

  // Blended to HKD only here — concentration risk does not care what
  // currency a position is priced in, unlike the pool cards and net-worth
  // chart, which never blend (PLAN rev 4). No stored rate for a currency
  // means "no live price" for allocation purposes too: an unconverted
  // number would misstate every other position's share, not just this one.
  const valueHkdMinorOf = (holding: (typeof holdings)[number]): bigint | null =>
    holding.marketValueMinor === null
      ? null
      : toHkdMinor(holding.marketValueMinor, holding.currency, rates)

  const allocations = computeAllocations(
    holdings.map((h) => ({
      instrumentId: h.instrumentId,
      accountId: h.accountId,
      valueHkdMinor: valueHkdMinorOf(h),
    })),
  )
  const accountNameById = new Map(holdings.map((h) => [h.accountId, h.accountName]))
  const symbolByInstrumentId = new Map(holdings.map((h) => [h.instrumentId, h.symbol]))
  const allocationRows: AllocationRow[] = allocations.map((a) => ({
    instrumentId: a.instrumentId,
    accountId: a.accountId,
    symbol: symbolByInstrumentId.get(a.instrumentId) ?? a.instrumentId,
    accountName: accountNameById.get(a.accountId) ?? a.accountId,
    percent: a.percent,
  }))

  const recentPositionRows: RecentPositionRow[] = recentPositions.map((p) => ({
    transactionId: p.transactionId,
    date: shortDate(p.occurredAt),
    mode: p.mode,
    symbol: p.symbol,
    accountName: p.accountName,
    quantity: formatQuantity(p.quantity),
    amount: formatMoney(money(p.amountMinor, p.currency)),
    description: p.description,
  }))

  // Only ever set from an Edit link on a row already rendered from
  // recentPositions above, so a match here is guaranteed to be one of the
  // positions the user can actually see and is allowed to edit.
  const editingSource = recentPositions.find((p) => p.transactionId === editingId)
  const editingPosition: EditingPosition | undefined = editingSource
    ? {
        transactionId: editingSource.transactionId,
        mode: editingSource.mode,
        instrumentId: editingSource.instrumentId,
        accountId: editingSource.accountId,
        quantity: formatQuantity(editingSource.quantity.replace(/^-/, '')),
        // A legacy position with unknown cost is stored as a zero-amount leg
        // (PLAN §3) — round-tripping that back to the blank "unknown" the
        // original form's optional Cost field means, not a misleading "0.00".
        amount:
          editingSource.mode === 'legacy' && editingSource.amountMinor === 0n
            ? ''
            : toDecimalString(money(absMinor(editingSource.amountMinor), editingSource.currency)),
        description: editingSource.description ?? '',
      }
    : undefined

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-1">
        <Link
          href="/"
          className="text-xs uppercase tracking-wide text-(--color-muted) hover:text-(--color-green)"
        >
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
        <p className="max-w-2xl text-sm text-(--color-muted)">
          Add instruments, record buys/sells/legacy positions, and set how much of any accepted
          allocation suggestion (<Link href="/allocations" className="underline">/allocations</Link>)
          goes to each — a weight is a share of new invest-money, not a rebalancing target.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
          Holdings
        </h2>
        <HoldingsTable holdings={holdings} />
      </section>

      <section className="flex flex-col gap-4 border-t border-(--color-line) pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
          Allocation
        </h2>
        <p className="text-xs text-(--color-muted)">
          Share of total investment value, blended to HKD at the current rate — the one number
          worth comparing across currencies, since concentration risk does not care which one a
          position is priced in.
        </p>
        <AllocationBreakdown
          rows={allocationRows}
          excludedCount={holdings.length - allocationRows.length}
        />
      </section>

      <section className="flex flex-col gap-4 border-t border-(--color-line) pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
          Instruments
        </h2>
        {instruments.length === 0 ? (
          <p className="text-sm text-(--color-muted)">None yet — add one below.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-(--color-line) text-left text-xs uppercase tracking-wide text-(--color-muted)">
                  <th className="py-2 pr-4 font-medium">Symbol</th>
                  <th className="py-2 pr-4 font-medium">Kind</th>
                  <th className="py-2 pr-4 font-medium">Currency</th>
                  <th className="py-2 text-right font-medium">Weight</th>
                </tr>
              </thead>
              <tbody>
                {instruments.map((i) => (
                  <tr key={i.id} className="border-b border-(--color-line)/60">
                    <td className="py-2 pr-4 font-medium">{i.symbol}</td>
                    <td className="py-2 pr-4 text-(--color-muted)">{i.kind}</td>
                    <td className="py-2 pr-4 text-(--color-muted)">{i.currency}</td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end">
                        <WeightInput
                          instrumentId={i.id}
                          weightPercent={bpsToPercentString(i.targetWeightBps)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="pt-2 text-xs text-(--color-muted)">
              Weights total {totalWeightPercent}%
              {totalWeightPercent < 100
                ? ` — the remaining ${(100 - totalWeightPercent).toFixed(2)}% goes to whichever account you pick when you accept a suggestion, same as before weighting existed.`
                : '.'}
            </p>
          </div>
        )}
        <InstrumentForm />
      </section>

      <section className="flex flex-col gap-4 border-t border-(--color-line) pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
          Recent positions
        </h2>
        <p className="text-xs text-(--color-muted)">
          Mis-typed a quantity or amount? Edit jumps to the form below pre-filled; Remove just
          deletes it. Either way the original entry is voided rather than changed in place, so
          what you actually did stays in the record.
        </p>
        <RecentPositions rows={recentPositionRows} />
      </section>

      <section id="position-form" className="flex flex-col gap-4 border-t border-(--color-line) pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
          {editingPosition ? 'Edit position' : 'Record a position'}
        </h2>
        <PositionForm
          key={editingPosition?.transactionId ?? 'new'}
          instruments={instruments}
          accounts={ownAccounts}
          editing={editingPosition}
        />
      </section>
    </main>
  )
}
