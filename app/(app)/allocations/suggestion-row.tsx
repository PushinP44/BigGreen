'use client'

import { useActionState, useState } from 'react'
import { acceptSuggestion, dismissSuggestion, type AllocationActionState } from './actions'
import type { PendingSuggestion } from '@/lib/read/allocations'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

const initial: AllocationActionState = {}

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
  const [acceptState, acceptAction] = useActionState(acceptSuggestion, initial)
  const [dismissState, dismissAction] = useActionState(dismissSuggestion, initial)

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border p-4">
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
        <p className="tabular text-xl font-semibold tracking-tight text-primary">
          HK${toDecimal(suggestion.suggestedHkdMinor)}
        </p>
      </div>

      {!showDismiss ? (
        <div className="flex flex-wrap items-center gap-3">
          <form action={acceptAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <Select name="toAccountId" required defaultValue="" className="w-auto">
              <option value="" disabled>
                Move to…
              </option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <SubmitButton pendingLabel="Scheduling…">Accept</SubmitButton>
          </form>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setShowDismiss(true)}
          >
            Dismiss
          </Button>
        </div>
      ) : (
        <form action={dismissAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <Input
            name="reason"
            required
            placeholder="Why? (e.g. already spoken for)"
            className="flex-1"
          />
          <SubmitButton variant="outlineDestructive" pendingLabel="Dismissing…">
            Confirm dismiss
          </SubmitButton>
          <Button type="button" variant="link" size="sm" onClick={() => setShowDismiss(false)}>
            Cancel
          </Button>
        </form>
      )}

      <FormStatus state={acceptState} />
      {/* Dismiss only ever reports failure — a successful dismiss removes the row. */}
      <FormStatus state={{ error: dismissState.error }} />
    </li>
  )
}
