'use client'

import { useActionState } from 'react'
import { refreshPrices, type ActionState } from './actions'

const initial: ActionState = {}

export function RefreshPrices() {
  const [state, formAction, pending] = useActionState(refreshPrices, initial)

  return (
    <form action={formAction} className="flex items-center gap-3">
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-(--color-line) px-3 py-1.5 text-xs uppercase tracking-wide text-(--color-muted) transition hover:border-(--color-green) hover:text-(--color-green) disabled:opacity-50"
      >
        {pending ? 'Fetching…' : 'Refresh prices'}
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
