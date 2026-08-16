import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
import { listAccountBalances } from '@/lib/read/accounts'
import { loadHoldings } from '@/lib/read/holdings'
import { HoldingsTable } from '../holdings-table'
import { InstrumentForm } from './instrument-form'
import { PositionForm } from './position-form'
import { WeightInput } from './weight-input'

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

export default async function PortfolioPage() {
  const { db } = await requireSessionDb()

  // Explicit `now`, threaded into every date decision — domain functions
  // never read the clock themselves (PLAN D4).
  const now = new Date()

  const [instrumentRows, accounts, holdings] = await Promise.all([
    db.query<InstrumentRow>(
      `SELECT id, symbol, kind::text AS kind, currency, target_weight_bps
         FROM instruments ORDER BY symbol`,
    ),
    listAccountBalances(db),
    loadHoldings(db, now),
  ])

  const instruments = instrumentRows.rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    kind: row.kind,
    currency: row.currency.trim(),
    targetWeightBps: row.target_weight_bps,
  }))

  const ownAccounts = accounts.filter((a) => a.isOwn).map((a) => ({ id: a.id, name: a.name }))

  const totalWeightPercent =
    instruments.reduce((sum, i) => sum + (i.targetWeightBps ?? 0), 0) / 100

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
          Record a position
        </h2>
        <PositionForm instruments={instruments} accounts={ownAccounts} />
      </section>
    </main>
  )
}
