'use client'

import { useActionState } from 'react'
import { addInstrument, type PortfolioActionState } from './actions'

const initial: PortfolioActionState = {}

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)'
const label = 'text-xs uppercase tracking-wide text-(--color-muted)'

const KINDS = [
  { value: 'stock', label: 'Stock' },
  { value: 'etf', label: 'ETF' },
  { value: 'index_fund', label: 'Index fund' },
  { value: 'mutual_fund', label: 'Mutual fund' },
]

export function InstrumentForm() {
  const [state, formAction, pending] = useActionState(addInstrument, initial)

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className={label}>Symbol</span>
        <input name="symbol" required placeholder="AAPL" className={`w-28 uppercase ${field}`} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={label}>Kind</span>
        <select name="kind" defaultValue="stock" className={field}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={label}>Currency</span>
        <select name="currency" defaultValue="USD" className={field}>
          <option value="USD">USD</option>
          <option value="HKD">HKD</option>
          <option value="THB">THB</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={label}>Exchange (optional)</span>
        <input name="exchange" placeholder="NASDAQ" className={`w-32 ${field}`} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-(--color-green) px-4 py-2 text-sm font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
      >
        {pending ? 'Adding…' : 'Add instrument'}
      </button>
      {state.error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </span>
      ) : null}
      {state.ok ? <span className="text-xs text-(--color-green)">{state.ok}</span> : null}
    </form>
  )
}
