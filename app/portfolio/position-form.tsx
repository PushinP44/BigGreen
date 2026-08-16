'use client'

import { useActionState, useState } from 'react'
import {
  recordLegacyPositionAction,
  recordTradeAction,
  type PortfolioActionState,
} from './actions'

const initial: PortfolioActionState = {}

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)'
const label = 'text-xs uppercase tracking-wide text-(--color-muted)'

type Mode = 'buy' | 'sell' | 'legacy'

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
  { value: 'legacy', label: 'Legacy position' },
]

export interface InstrumentOption {
  readonly id: string
  readonly symbol: string
  readonly currency: string
}

export interface AccountOption {
  readonly id: string
  readonly name: string
}

/**
 * Buy / sell / legacy in one sheet, same segmented-control shape as the main
 * entry form (PLAN §4.3/§4.4). Buy and sell both settle against — and hold
 * the position in — the same account; a legacy position instead balances
 * against Opening Equity, with cost optional (`COST UNKNOWN`, not zero).
 */
export function PositionForm({
  instruments,
  accounts,
}: {
  instruments: readonly InstrumentOption[]
  accounts: readonly AccountOption[]
}) {
  const [mode, setMode] = useState<Mode>('buy')
  const [instrumentId, setInstrumentId] = useState(instruments[0]?.id ?? '')

  const [tradeState, tradeAction, tradePending] = useActionState(recordTradeAction, initial)
  const [legacyState, legacyAction, legacyPending] = useActionState(
    recordLegacyPositionAction,
    initial,
  )

  // `instrumentId` only gets its initial value at mount, so an instrument
  // added after this component first rendered with an empty list would
  // otherwise leave it stuck on '' forever — a server-action refresh updates
  // `instruments` without remounting this client component. Fall back to the
  // first instrument whenever the stored id no longer matches one currently
  // in the list, rather than trusting raw state directly.
  const selectedId = instruments.some((i) => i.id === instrumentId)
    ? instrumentId
    : (instruments[0]?.id ?? '')
  const instrument = instruments.find((i) => i.id === selectedId)

  if (instruments.length === 0) {
    return (
      <p className="text-sm text-(--color-muted)">
        Add an instrument above before recording a position.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 rounded-lg border border-(--color-line) p-1">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm transition ${
              mode === m.value
                ? 'bg-(--color-green) text-white'
                : 'text-(--color-muted) hover:text-(--color-green)'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'buy' || mode === 'sell' ? (
        <form action={tradeAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="side" value={mode} />
          <label className="flex flex-col gap-1">
            <span className={label}>Instrument</span>
            <select
              name="instrumentId"
              value={selectedId}
              onChange={(e) => setInstrumentId(e.target.value)}
              className={field}
            >
              {instruments.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.symbol} ({i.currency})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Account</span>
            <select name="accountId" required className={field} defaultValue={accounts[0]?.id ?? ''}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Quantity</span>
            <input name="quantity" required inputMode="decimal" placeholder="10" className={`w-24 ${field}`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>
              {mode === 'buy' ? 'Total cost' : 'Total proceeds'} ({instrument?.currency ?? ''})
            </span>
            <input name="amount" required inputMode="decimal" placeholder="1500.00" className={`w-32 ${field}`} />
          </label>
          <label className="flex flex-1 min-w-40 flex-col gap-1">
            <span className={label}>Note (optional)</span>
            <input name="description" className={field} />
          </label>
          <button
            type="submit"
            disabled={tradePending}
            className="rounded-md bg-(--color-green) px-4 py-2 text-sm font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
          >
            {tradePending ? 'Recording…' : mode === 'buy' ? 'Record buy' : 'Record sale'}
          </button>
          {tradeState.error ? (
            <span role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
              {tradeState.error}
            </span>
          ) : null}
          {tradeState.ok ? (
            <span className="w-full text-xs text-(--color-green)">{tradeState.ok}</span>
          ) : null}
        </form>
      ) : (
        <form action={legacyAction} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className={label}>Instrument</span>
            <select
              name="instrumentId"
              value={selectedId}
              onChange={(e) => setInstrumentId(e.target.value)}
              className={field}
            >
              {instruments.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.symbol} ({i.currency})
                </option>
              ))}
            </select>
          </label>
          <input type="hidden" name="currency" value={instrument?.currency ?? ''} />
          <label className="flex flex-col gap-1">
            <span className={label}>Account</span>
            <select name="accountId" required className={field} defaultValue={accounts[0]?.id ?? ''}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Quantity</span>
            <input name="quantity" required inputMode="decimal" placeholder="10" className={`w-24 ${field}`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Cost (optional)</span>
            <input name="cost" inputMode="decimal" placeholder="Leave blank if unknown" className={`w-44 ${field}`} />
          </label>
          <label className="flex flex-1 min-w-40 flex-col gap-1">
            <span className={label}>Note (optional)</span>
            <input name="description" className={field} />
          </label>
          <button
            type="submit"
            disabled={legacyPending}
            className="rounded-md bg-(--color-green) px-4 py-2 text-sm font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
          >
            {legacyPending ? 'Adding…' : 'Add legacy position'}
          </button>
          {legacyState.error ? (
            <span role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
              {legacyState.error}
            </span>
          ) : null}
          {legacyState.ok ? (
            <span className="w-full text-xs text-(--color-green)">{legacyState.ok}</span>
          ) : null}
        </form>
      )}
    </div>
  )
}
