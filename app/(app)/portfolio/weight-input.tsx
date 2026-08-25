'use client'

import { useActionState } from 'react'
import { saveWeight, type PortfolioActionState } from './actions'

const initial: PortfolioActionState = {}

export function WeightInput({
  instrumentId,
  weightPercent,
}: {
  instrumentId: string
  weightPercent: string
}) {
  const [state, formAction, pending] = useActionState(saveWeight, initial)

  return (
    <form action={formAction} className="flex items-center gap-1.5">
      <input type="hidden" name="instrumentId" value={instrumentId} />
      <input
        name="weightPercent"
        inputMode="decimal"
        defaultValue={weightPercent}
        placeholder="—"
        title="% of new invest-money that goes here when a suggestion is accepted"
        className="tabular w-14 rounded-md border border-(--color-line) bg-transparent px-2 py-1 text-right text-sm outline-none focus:border-(--color-green)"
      />
      <span className="text-xs text-muted-foreground">%</span>
      <button
        type="submit"
        disabled={pending}
        className="text-xs text-muted-foreground underline hover:text-(--color-green) disabled:opacity-50"
      >
        {pending ? '…' : 'save'}
      </button>
      {state.error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </span>
      ) : null}
    </form>
  )
}
