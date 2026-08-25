'use client'

import { useActionState, useState } from 'react'
import { archiveAccount, createAccount, type AccountState } from './actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Field, FieldHint, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

const initial: AccountState = {}

const KINDS = [
  { value: 'bank', label: 'Bank account' },
  { value: 'cash', label: 'Cash' },
  { value: 'ewallet', label: 'E-wallet' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'brokerage', label: 'Brokerage' },
]

const CURRENCIES = ['HKD', 'USD', 'THB'] as const

export function AccountForm() {
  const [state, formAction] = useActionState(createAccount, initial)
  const [kind, setKind] = useState('bank')

  // A card is a liability, never spendable cash — the database CHECK enforces
  // this too, so offering the toggle would only invite a confusing rejection.
  const canBeLiquid = kind !== 'credit_card'

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Field className="min-w-48 flex-1">
          <FieldLabel>Name</FieldLabel>
          <Input name="name" required placeholder="HSBC HKD" />
        </Field>

        <Field>
          <FieldLabel>Kind</FieldLabel>
          <Select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            {KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field>
          <FieldLabel>Currency</FieldLabel>
          <Select name="currency" defaultValue="HKD">
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Field>
          <FieldLabel>Institution (optional)</FieldLabel>
          <Input name="institution" placeholder="hsbc" className="w-40" />
        </Field>

        {canBeLiquid ? (
          <label className="flex items-center gap-2 pt-5 text-sm">
            <input
              type="checkbox"
              name="isLiquid"
              defaultChecked
              className="size-4 accent-primary"
            />
            <span>
              Spendable
              <span className="ml-1 text-xs text-muted-foreground">
                — counts toward safe-to-spend
              </span>
            </span>
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Field>
          <FieldLabel>Opening balance (optional)</FieldLabel>
          <Input name="openingBalance" inputMode="decimal" placeholder="0.00" className="tabular w-36" />
        </Field>

        <Field>
          <FieldLabel>
            {kind === 'credit_card' ? 'Card ends in (optional)' : 'Account starts with (optional)'}
          </FieldLabel>
          <Input
            name="accountDigits"
            inputMode="numeric"
            maxLength={4}
            placeholder={kind === 'credit_card' ? '4321' : '1234'}
            className="tabular w-28"
          />
        </Field>
      </div>

      <div className="flex items-center gap-4">
        <SubmitButton size="lg" className="self-start" pendingLabel="Adding…">
          Add account
        </SubmitButton>
        <FormStatus state={state} />
      </div>

      <FieldHint>
        The institution is what matches emailed alerts to this account — <code>hsbc</code>,{' '}
        <code>za</code>, <code>mox</code>, <code>ktb</code>. Leave it blank if the account never
        emails you. If it does, the digits narrow an alert down to this account when the
        institution has more than one — both fields can also be set later from the list above.
      </FieldHint>
    </form>
  )
}

export function ArchiveButton({ id }: { id: string }) {
  const [state, formAction] = useActionState(archiveAccount, initial)

  return (
    <form action={formAction}>
      <input type="hidden" name="accountId" value={id} />
      <SubmitButton
        variant="outlineDestructive"
        size="xs"
        title="Archive — history is kept"
        pendingLabel="…"
      >
        {state.error ? 'failed' : 'archive'}
      </SubmitButton>
    </form>
  )
}
