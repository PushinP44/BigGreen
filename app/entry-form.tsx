'use client'

import { useActionState } from 'react'
import { addTransaction, type ActionState } from './actions'

export interface AccountOption {
  readonly id: string
  readonly name: string
  readonly currency: string
}

const initial: ActionState = {}

/**
 * The entry form. With import cut (PLAN rev 3) this is the only way data gets
 * into the ledger, so speed matters more than polish: the amount field is
 * autofocused, everything is reachable by keyboard, and the form does not reset
 * the account between entries.
 */
export function EntryForm({ accounts }: { accounts: readonly AccountOption[] }) {
  const [state, formAction, pending] = useActionState(addTransaction, initial)

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 min-w-32">
          <span className="text-xs uppercase tracking-wide text-(--color-muted)">Amount</span>
          <input
            name="amount"
            inputMode="decimal"
            autoFocus
            required
            placeholder="0.00"
            className="tabular rounded-md border border-(--color-line) bg-transparent px-3 py-2 text-lg outline-none focus:border-(--color-green)"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-(--color-muted)">Direction</span>
          <select
            name="direction"
            defaultValue="spend"
            className="rounded-md border border-(--color-line) bg-transparent px-3 py-2 text-lg outline-none focus:border-(--color-green)"
          >
            <option value="spend">Spend</option>
            <option value="income">Income</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-(--color-muted)">Account</span>
          <select
            name="accountId"
            required
            className="rounded-md border border-(--color-line) bg-transparent px-3 py-2 text-lg outline-none focus:border-(--color-green)"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currency}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1 min-w-48">
          <span className="text-xs uppercase tracking-wide text-(--color-muted)">Description</span>
          <input
            name="description"
            placeholder="Lunch, MTR, salary…"
            className="rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)"
          />
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
