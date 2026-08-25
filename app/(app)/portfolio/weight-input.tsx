'use client'

import { useActionState } from 'react'
import { saveWeight, type PortfolioActionState } from './actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Input } from '@/components/ui/input'

const initial: PortfolioActionState = {}

export function WeightInput({
  instrumentId,
  weightPercent,
}: {
  instrumentId: string
  weightPercent: string
}) {
  const [state, formAction] = useActionState(saveWeight, initial)

  return (
    <form action={formAction} className="flex items-center gap-1.5">
      <input type="hidden" name="instrumentId" value={instrumentId} />
      <Input
        name="weightPercent"
        inputMode="decimal"
        defaultValue={weightPercent}
        placeholder="—"
        title="% of new invest-money that goes here when a suggestion is accepted"
        className="tabular h-8 w-14 px-2 text-right text-sm"
      />
      <span className="text-xs text-muted-foreground">%</span>
      <SubmitButton variant="link" size="xs" pendingLabel="…">
        save
      </SubmitButton>
      <FormStatus state={state} />
    </form>
  )
}
