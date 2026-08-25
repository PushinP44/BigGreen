'use client'

import { useActionState } from 'react'
import { RefreshCw } from 'lucide-react'
import { refreshPrices, refreshRates, type ActionState } from '@/app/actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'

const initial: ActionState = {}

const SOURCES = {
  rates: { action: refreshRates, label: 'Refresh rates' },
  prices: { action: refreshPrices, label: 'Refresh prices' },
} as const

/**
 * Replaces `app/refresh-rates.tsx` and `app/refresh-prices.tsx`, which were
 * line-for-line identical apart from the imported action and the button label.
 *
 * The action is selected from a local map rather than passed in as a prop so
 * that callers stay plain (`<RefreshButton source="rates" />`) and the two
 * Server Actions are still statically imported.
 */
export function RefreshButton({ source }: { source: keyof typeof SOURCES }) {
  const { action, label } = SOURCES[source]
  const [state, formAction] = useActionState(action, initial)

  return (
    <form action={formAction} className="flex items-center gap-3">
      <SubmitButton variant="outline" size="sm" pendingLabel="Fetching…">
        <RefreshCw aria-hidden />
        {label}
      </SubmitButton>
      <FormStatus state={state} />
    </form>
  )
}
