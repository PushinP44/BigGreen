'use client'

import { useActionState, useState } from 'react'
import { addTransaction, type ActionState } from './actions'

export interface AccountOption {
  readonly id: string
  readonly name: string
  readonly currency: string
}

export interface CategoryOption {
  readonly id: string
  readonly name: string
}

type Kind = 'spend' | 'income' | 'transfer'

const initial: ActionState = {}

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'spend', label: 'Spend' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
]

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)'
const label = 'text-xs uppercase tracking-wide text-(--color-muted)'

/**
 * The `+` sheet: three flows, one segmented control (PLAN §4).
 *
 * With import cut (PLAN rev 3) this is the only way data enters the ledger, so
 * entry speed is a primary feature rather than a fallback — the amount field
 * autofocuses, the account selection survives between entries, and every
 * control is reachable from the keyboard.
 */
export function EntryForm({
  accounts,
  categories,
}: {
  accounts: readonly AccountOption[]
  categories: readonly CategoryOption[]
}) {
  const [state, formAction, pending] = useActionState(addTransaction, initial)
  const [kind, setKind] = useState<Kind>('spend')
  const [fromId, setFromId] = useState(accounts[0]?.id ?? '')
  const [toId, setToId] = useState(accounts[1]?.id ?? '')

  const currencyOf = (id: string) => accounts.find((a) => a.id === id)?.currency
  // Only you know what the bank actually credited, so a cross-currency
  // transfer has to ask rather than apply the reference rate.
  const crossCurrency =
    kind === 'transfer' && !!fromId && !!toId && currencyOf(fromId) !== currencyOf(toId)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="kind" value={kind} />

      <div className="flex gap-1 rounded-lg border border-(--color-line) p-1 self-start">
        {KINDS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setKind(option.value)}
            aria-pressed={kind === option.value}
            className={`rounded-md px-4 py-1.5 text-sm transition ${
              kind === option.value
                ? 'bg-(--color-green) text-white'
                : 'text-(--color-muted) hover:text-(--color-ink) dark:hover:text-white'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 min-w-32">
          <span className={label}>Amount</span>
          <input
            name="amount"
            inputMode="decimal"
            autoFocus
            required
            placeholder="0.00"
            className={`tabular text-lg ${field}`}
          />
        </label>

        {kind === 'transfer' ? (
          <>
            <label className="flex flex-col gap-1">
              <span className={label}>From</span>
              <select
                name="fromAccountId"
                value={fromId}
                onChange={(event) => setFromId(event.target.value)}
                className={`text-lg ${field}`}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className={label}>To</span>
              <select
                name="toAccountId"
                value={toId}
                onChange={(event) => setToId(event.target.value)}
                className={`text-lg ${field}`}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className={label}>Account</span>
              <select name="accountId" required className={`text-lg ${field}`}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
            </label>

            {kind === 'spend' ? (
              <label className="flex flex-col gap-1">
                <span className={label}>Category</span>
                <select name="categoryId" className={`text-lg ${field}`}>
                  <option value="">Uncategorised</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        )}
      </div>

      {crossCurrency ? (
        <label className="flex flex-col gap-1 max-w-xs">
          <span className={label}>Amount received ({currencyOf(toId)})</span>
          <input
            name="toAmount"
            inputMode="decimal"
            required
            placeholder="0.00"
            className={`tabular text-lg ${field}`}
          />
          <span className="text-xs text-(--color-muted)">
            What actually landed. The difference against the reference rate is your bank&rsquo;s
            spread and is booked to FX Gain/Loss.
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1 min-w-48">
          <span className={label}>Description</span>
          <input name="description" placeholder="Lunch, MTR, salary…" className={field} />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-(--color-green) px-5 py-2.5 font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
        >
          {pending ? 'Recording…' : 'Record'}
        </button>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.ok ? <p className="text-sm text-(--color-green)">{state.ok}</p> : null}
    </form>
  )
}
