'use client'

import { useActionState } from 'react'
import { saveCard, type SettingsState } from './actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export interface CardRow {
  readonly id: string
  readonly name: string
  readonly currency: string
  readonly statementDay: number | null
  readonly paymentDueDay: number | null
  readonly creditLimitMinor: string | null
  readonly aprBps: number | null
  readonly minPaymentPctBps: number | null
  readonly minPaymentFloorMinor: string | null
  readonly accountLast4: string | null
}

const initial: SettingsState = {}

function toDecimal(minor: string | null, decimals = 2): string {
  if (minor === null) return ''
  const value = BigInt(minor)
  const factor = 10n ** BigInt(decimals)
  return `${value / factor}.${(value % factor).toString().padStart(decimals, '0')}`
}

function bpsToPercent(bps: number | null): string {
  return bps === null ? '' : String(bps / 100)
}

export function CardSettings({ cards }: { cards: readonly CardRow[] }) {
  const [state, formAction] = useActionState(saveCard, initial)

  if (cards.length === 0) {
    return <p className="text-sm text-muted-foreground">No credit card accounts yet.</p>
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <p className="max-w-2xl text-sm text-muted-foreground">
        With these filled in, the safety rule uses the real billing cycle: only the{' '}
        <strong>minimum payment</strong> due before your horizon counts against what you can
        spend, instead of the entire balance. Leave them blank and it falls back to treating the
        whole balance as due — safe, but punishing if you carry one.
      </p>

      {cards.map((card) => (
        <div key={card.id} className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <input type="hidden" name="cardIds" value={card.id} />
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{card.name}</span>
            <span className="text-xs text-muted-foreground">{card.currency}</span>
          </div>

          <div className="flex flex-wrap gap-3">
            <Field>
              <FieldLabel>Statement closes (day)</FieldLabel>
              <Input
                name={`statementDay.${card.id}`}
                inputMode="numeric"
                placeholder="25"
                defaultValue={card.statementDay ?? ''}
                className="tabular w-32"
              />
            </Field>

            <Field>
              <FieldLabel>Payment due (day)</FieldLabel>
              <Input
                name={`paymentDueDay.${card.id}`}
                inputMode="numeric"
                placeholder="15"
                defaultValue={card.paymentDueDay ?? ''}
                className="tabular w-32"
              />
            </Field>

            <Field>
              <FieldLabel>Card ends in</FieldLabel>
              <Input
                name={`last4.${card.id}`}
                inputMode="numeric"
                maxLength={4}
                placeholder="4321"
                defaultValue={card.accountLast4 ?? ''}
                className="tabular w-28"
              />
            </Field>

            <Field>
              <FieldLabel>Credit limit</FieldLabel>
              <Input
                name={`creditLimit.${card.id}`}
                inputMode="decimal"
                placeholder="50000.00"
                defaultValue={toDecimal(card.creditLimitMinor)}
                className="tabular w-40"
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-3">
            <Field>
              <FieldLabel>APR %</FieldLabel>
              <Input
                name={`apr.${card.id}`}
                inputMode="decimal"
                placeholder="36"
                defaultValue={bpsToPercent(card.aprBps)}
                className="tabular w-28"
              />
            </Field>

            <Field>
              <FieldLabel>Min payment %</FieldLabel>
              <Input
                name={`minPct.${card.id}`}
                inputMode="decimal"
                placeholder="1"
                defaultValue={bpsToPercent(card.minPaymentPctBps)}
                className="tabular w-32"
              />
            </Field>

            <Field>
              <FieldLabel>Min payment floor</FieldLabel>
              <Input
                name={`minFloor.${card.id}`}
                inputMode="decimal"
                placeholder="50.00"
                defaultValue={toDecimal(card.minPaymentFloorMinor)}
                className="tabular w-36"
              />
            </Field>
          </div>

          <p className="text-xs text-muted-foreground">
            The last four digits are how an emailed alert is matched to this card. Without them,
            an alert naming a card number cannot be filed with certainty and waits for review.
            A statement day of 31 is fine — short months clamp to their last day. If your due day
            falls before your statement day, it is read as the following month.
          </p>
        </div>
      ))}

      <div className="flex items-center gap-4">
        <SubmitButton size="lg" className="self-start" pendingLabel="Saving…">
          Save cards
        </SubmitButton>
        <FormStatus state={state} />
      </div>
    </form>
  )
}
