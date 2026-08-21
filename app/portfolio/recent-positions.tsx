'use client'

import { useActionState } from 'react'
import { voidPositionAction, type PortfolioActionState } from './actions'

const initial: PortfolioActionState = {}

export interface RecentPositionRow {
  readonly transactionId: string
  readonly date: string
  readonly mode: 'buy' | 'sell' | 'legacy'
  readonly symbol: string
  readonly accountName: string
  readonly quantity: string
  readonly amount: string
  readonly description: string | null
}

const MODE_LABEL: Record<RecentPositionRow['mode'], string> = {
  buy: 'Buy',
  sell: 'Sell',
  legacy: 'Legacy',
}

function PositionRow({ row }: { row: RecentPositionRow }) {
  const [state, formAction, pending] = useActionState(voidPositionAction, initial)

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-(--color-line) p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="tabular text-xs text-(--color-muted)">{row.date}</span>
        <span className="rounded bg-(--color-line) px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-(--color-muted)">
          {MODE_LABEL[row.mode]}
        </span>
        <span className="font-medium">{row.symbol}</span>
        <span className="text-xs text-(--color-muted)">{row.accountName}</span>
        <span className="tabular flex-1 text-right text-(--color-muted)">{row.quantity} sh</span>
        <span className="tabular font-medium">{row.amount}</span>
      </div>

      {row.description ? (
        <p className="text-xs text-(--color-muted)">{row.description}</p>
      ) : null}

      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="transactionId" value={row.transactionId} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-(--color-line) px-3 py-1 text-xs text-(--color-muted) transition hover:border-red-500/50 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
        >
          {pending ? '…' : 'Remove'}
        </button>
        {state.error ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {state.error}
          </span>
        ) : null}
        {state.ok ? <span className="text-xs text-(--color-green)">{state.ok}</span> : null}
      </form>
    </li>
  )
}

/**
 * The last few buy/sell/legacy entries, each removable — for the typo case:
 * wrong quantity, wrong account, wrong amount. Remove voids the transaction
 * rather than editing it in place (same convention as `/review`'s discard),
 * so re-entering the correct version with the form above is the fix, not an
 * in-place patch that could leave a transaction's legs out of balance.
 */
export function RecentPositions({ rows }: { rows: readonly RecentPositionRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-(--color-muted)">No positions recorded yet.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <PositionRow key={row.transactionId} row={row} />
      ))}
    </ul>
  )
}
