'use client'

import { useActionState } from 'react'
import { resolvePending, type ReviewState } from './actions'

const initial: ReviewState = {}

export function PendingRow({
  id,
  date,
  description,
  accountName,
  amount,
  notes,
}: {
  id: string
  date: string
  description: string
  accountName: string
  amount: string
  notes: string
}) {
  const [state, formAction, pending] = useActionState(resolvePending, initial)

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-(--color-line) p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="tabular text-xs text-(--color-muted)">{date}</span>
        <span className="flex-1 font-medium">{description}</span>
        <span className="text-xs text-(--color-muted)">{accountName}</span>
        <span className="tabular font-medium">{amount}</span>
      </div>

      {/*
        The reason it is here, verbatim. "Needs review" without saying why makes
        every row an equal amount of work; naming the doubt lets you glance at
        most of them.
      */}
      {notes ? (
        <pre className="whitespace-pre-wrap rounded bg-(--color-line)/40 px-3 py-2 text-xs text-(--color-muted)">
          {notes}
        </pre>
      ) : null}

      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="transactionId" value={id} />
        <button
          type="submit"
          name="action"
          value="confirm"
          disabled={pending}
          className="rounded-md bg-(--color-green) px-4 py-1.5 text-sm font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
        >
          {pending ? '…' : 'Confirm'}
        </button>
        <button
          type="submit"
          name="action"
          value="discard"
          disabled={pending}
          className="rounded-md border border-(--color-line) px-4 py-1.5 text-sm text-(--color-muted) transition hover:border-red-500/50 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
        >
          Discard
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
