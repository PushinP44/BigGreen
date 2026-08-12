'use client'

import { useActionState, useState } from 'react'
import { archiveAccount, createAccount, type AccountState } from './actions'

const initial: AccountState = {}

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)'
const label = 'text-xs uppercase tracking-wide text-(--color-muted)'

const KINDS = [
  { value: 'bank', label: 'Bank account' },
  { value: 'cash', label: 'Cash' },
  { value: 'ewallet', label: 'E-wallet' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'brokerage', label: 'Brokerage' },
]

export function AccountForm() {
  const [state, formAction, pending] = useActionState(createAccount, initial)
  const [kind, setKind] = useState('bank')

  // A card is a liability, never spendable cash — the database CHECK enforces
  // this too, so offering the toggle would only invite a confusing rejection.
  const canBeLiquid = kind !== 'credit_card'

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 min-w-48">
          <span className={label}>Name</span>
          <input name="name" required placeholder="HSBC HKD" className={field} />
        </label>

        <label className="flex flex-col gap-1">
          <span className={label}>Kind</span>
          <select
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className={field}
          >
            {KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={label}>Currency</span>
          <select name="currency" defaultValue="HKD" className={field}>
            <option value="HKD">HKD</option>
            <option value="USD">USD</option>
            <option value="THB">THB</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex flex-col gap-1">
          <span className={label}>Institution (optional)</span>
          <input
            name="institution"
            placeholder="hsbc"
            className={`${field} w-40`}
          />
        </label>

        {canBeLiquid ? (
          <label className="flex items-center gap-2 pt-5 text-sm">
            <input type="checkbox" name="isLiquid" defaultChecked />
            <span>
              Spendable
              <span className="ml-1 text-xs text-(--color-muted)">
                — counts toward safe-to-spend
              </span>
            </span>
          </label>
        ) : null}
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-(--color-green) px-5 py-2.5 font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Add account'}
        </button>
        {state.error ? (
          <span role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </span>
        ) : null}
        {state.ok ? <span className="text-sm text-(--color-green)">{state.ok}</span> : null}
      </div>

      <p className="text-xs text-(--color-muted)">
        The institution is what matches emailed alerts to this account — <code>hsbc</code>,{' '}
        <code>za</code>, <code>mox</code>, <code>ktb</code>. Leave it blank if the account never
        emails you.
      </p>
    </form>
  )
}

export function ArchiveButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(archiveAccount, initial)

  return (
    <form action={formAction}>
      <input type="hidden" name="accountId" value={id} />
      <button
        type="submit"
        disabled={pending}
        title="Archive — history is kept"
        className="text-xs text-(--color-muted) transition hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
      >
        {pending ? '…' : state.error ? 'failed' : 'archive'}
      </button>
    </form>
  )
}
