'use client'

import { useActionState } from 'react'
import { addInstrument, type PortfolioActionState } from './actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

const initial: PortfolioActionState = {}

const KINDS = [
  { value: 'stock', label: 'Stock' },
  { value: 'etf', label: 'ETF' },
  { value: 'index_fund', label: 'Index fund' },
  { value: 'mutual_fund', label: 'Mutual fund' },
]

const CURRENCIES = ['USD', 'HKD', 'THB'] as const

export function InstrumentForm() {
  const [state, formAction] = useActionState(addInstrument, initial)

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <Field>
        <FieldLabel>Symbol</FieldLabel>
        <Input name="symbol" required placeholder="AAPL" className="w-28 uppercase" />
      </Field>
      <Field>
        <FieldLabel>Kind</FieldLabel>
        <Select name="kind" defaultValue="stock">
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel>Currency</FieldLabel>
        <Select name="currency" defaultValue="USD">
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel>Exchange (optional)</FieldLabel>
        <Input name="exchange" placeholder="NASDAQ" className="w-32" />
      </Field>
      <SubmitButton pendingLabel="Adding…">Add instrument</SubmitButton>
      <FormStatus state={state} />
    </form>
  )
}
