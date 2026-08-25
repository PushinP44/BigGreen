'use client'

import { useActionState } from 'react'
import { resolvePending, type ReviewState } from './actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'

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
  const [state, formAction] = useActionState(resolvePending, initial)

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="tabular text-xs text-muted-foreground">{date}</span>
        <span className="flex-1 font-medium">{description}</span>
        <span className="text-xs text-muted-foreground">{accountName}</span>
        <span className="tabular font-medium">{amount}</span>
      </div>

      {/*
        The reason it is here, verbatim. "Needs review" without saying why makes
        every row an equal amount of work; naming the doubt lets you glance at
        most of them.
      */}
      {notes ? (
        <pre className="whitespace-pre-wrap rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
          {notes}
        </pre>
      ) : null}

      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="transactionId" value={id} />
        {/*
          Both buttons submit the same form and are told apart server-side by
          `name="action"` — so these have to stay real submit buttons carrying
          a value, not handlers.
        */}
        <SubmitButton name="action" value="confirm" pendingLabel="…">
          Confirm
        </SubmitButton>
        <SubmitButton name="action" value="discard" variant="outlineDestructive">
          Discard
        </SubmitButton>
        <FormStatus state={state} />
      </form>
    </li>
  )
}
