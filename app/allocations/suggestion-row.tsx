'use client'

import { useActionState, useState } from 'react'
import { acceptSuggestion, dismissSuggestion, type AllocationActionState } from './actions'
import type { PendingSuggestion } from '@/lib/read/allocations'

const initial: AllocationActionState = {}

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 text-sm outline-none focus:border-(--color-green)'

export interface DestinationAccount {
  readonly id: string
  readonly name: string
}

function toDecimal(minor: string, decimals = 2): string {
  const value = BigInt(minor)
  const factor = 10n ** BigInt(decimals)
  return `${value / factor}.${(value % factor).toString().padStart(decimals, '0')}`
}

export function SuggestionRow({
  suggestion,
  accounts,
}: {
  suggestion: PendingSuggestion
  accounts: readonly DestinationAccount[]
}) {
  const [showDismiss, setShowDismiss] = useState(false)
  const [acceptState, acceptAction, acceptPending] = useActionState(acceptSuggestion, initial)
  const [dismissState, dismissAction, dismissPending] = useActionState(dismissSuggestion, initial)

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-(--color-line) p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm">
            {suggestion.triggerDescription || 'Inflow'}
            {suggestion.fromAccountName ? (
              <span className="text-muted-foreground"> · {suggestion.fromAccountName}</span>
            ) : null}
          </p>
          <p className="tabular text-xs text-muted-foreground">
            HK${toDecimal(suggestion.inflowHkdMinor)} in
          </p>
        </div>
        <p className="tabular text-xl font-semibold text-(--color-green)">
          HK${toDecimal(suggestion.suggestedHkdMinor)}
        </p>
      </div>

      {!showDismiss ? (
        <div className="flex flex-wrap items-center gap-3">
          <form action={acceptAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <select name="toAccountId" required className={field} defaultValue="">
              <option value="" disabled>
                Move to…
              </option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={acceptPending}
              className="rounded-md bg-(--color-green) px-4 py-2 text-sm font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
            >
              {acceptPending ? 'Scheduling…' : 'Accept'}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setShowDismiss(true)}
            className="text-xs text-muted-foreground underline hover:text-red-600 dark:hover:text-red-400"
          >
            Dismiss
          </button>
        </div>
      ) : (
        <form action={dismissAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <input
            name="reason"
            required
            placeholder="Why? (e.g. already spoken for)"
            className={`flex-1 ${field}`}
          />
          <button
            type="submit"
            disabled={dismissPending}
            className="rounded-md border border-(--color-line) px-4 py-2 text-sm transition hover:border-red-500 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
          >
            {dismissPending ? 'Dismissing…' : 'Confirm dismiss'}
          </button>
          <button
            type="button"
            onClick={() => setShowDismiss(false)}
            className="text-xs text-muted-foreground underline"
          >
            Cancel
          </button>
        </form>
      )}

      {acceptState.error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {acceptState.error}
        </span>
      ) : null}
      {acceptState.ok ? <span className="text-xs text-(--color-green)">{acceptState.ok}</span> : null}
      {dismissState.error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {dismissState.error}
        </span>
      ) : null}
    </li>
  )
}
