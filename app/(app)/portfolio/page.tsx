import Link from 'next/link'
import { PageHeader, PageShell, Section } from '@/components/page-shell'
import { requireSessionDb } from '@/lib/db/session'
import { listAccountBalances, rateTableFor } from '@/lib/read/accounts'
import { loadHoldings, listPositions } from '@/lib/read/holdings'
import { computeAllocations } from '@/lib/domain/holdings'
import { shortDate } from '@/lib/format'
import { formatMoney, money, toDecimalString, toHkdMinor } from '@/lib/domain/money'
import { HoldingsTable, formatQuantity } from '@/components/holdings-table'
import { AllocationBreakdown, type AllocationRow } from './allocation'
import { InstrumentForm } from './instrument-form'
import { PositionForm, type EditingPosition } from './position-form'
import { PositionList, type PositionListRow } from './position-list'
import { WeightInput } from './weight-input'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

function absMinor(amountMinor: bigint): bigint {
  return amountMinor < 0n ? -amountMinor : amountMinor
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

  const [instrumentRows, accounts, holdings, rates, positions] = await Promise.all([
    db.query<InstrumentRow>(
      `SELECT id, symbol, kind::text AS kind, currency, target_weight_bps
         FROM instruments ORDER BY symbol`,
    ),
    listAccountBalances(db),
    loadHoldings(db, now),
    rateTableFor(db),
    listPositions(db),
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

  const positionRows: PositionListRow[] = positions.map((p) => ({
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
  // positions above, so a match here is guaranteed to be one of the
  // positions the user can actually see and is allowed to edit.
  const editingSource = positions.find((p) => p.transactionId === editingId)
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
    <PageShell>
      <PageHeader
        title="Portfolio"
        description={
          <>
            Add instruments, record buys/sells/legacy positions, and set how much of any accepted
            allocation suggestion (<Link href="/allocations" className="underline">/allocations</Link>)
            goes to each — a weight is a share of new invest-money, not a rebalancing target.
          </>
        }
      />

      <Section title="Holdings" divided={false}>
        <HoldingsTable holdings={holdings} />
      </Section>

      <Section
        title="Allocation"
        description="Share of total investment value, blended to HKD at the current rate — the one number worth comparing across currencies, since concentration risk does not care which one a position is priced in."
      >
        <AllocationBreakdown
          rows={allocationRows}
          excludedCount={holdings.length - allocationRows.length}
        />
      </Section>

      <Section title="Instruments">
        {instruments.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet — add one below.</p>
        ) : (
          <div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead className="text-right">Weight</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instruments.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">{i.symbol}</TableCell>
                    <TableCell className="text-muted-foreground">{i.kind}</TableCell>
                    <TableCell className="text-muted-foreground">{i.currency}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <WeightInput
                          instrumentId={i.id}
                          weightPercent={bpsToPercentString(i.targetWeightBps)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TableCaption>
              Weights total {totalWeightPercent}%
              {totalWeightPercent < 100
                ? ` — the remaining ${(100 - totalWeightPercent).toFixed(2)}% goes to whichever account you pick when you accept a suggestion, same as before weighting existed.`
                : '.'}
            </TableCaption>
          </div>
        )}
        <InstrumentForm />
      </Section>

      <Section
        title="Positions"
        description="Every buy/sell/legacy entry, newest first. Mis-typed a quantity or amount? Edit jumps to the form below pre-filled; Remove just deletes it. Either way the original entry is voided rather than changed in place, so what you actually did stays in the record."
      >
        <PositionList rows={positionRows} />
      </Section>

      <Section id="position-form" title={editingPosition ? 'Edit position' : 'Record a position'}>
        <PositionForm
          key={editingPosition?.transactionId ?? 'new'}
          instruments={instruments}
          accounts={ownAccounts}
          editing={editingPosition}
        />
      </Section>

    </PageShell>
  )
}
