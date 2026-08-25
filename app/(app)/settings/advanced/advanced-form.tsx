'use client'

import { useActionState } from 'react'
import { Section, SectionHeading } from '@/components/page-shell'
import { saveAdvancedSettings, type SettingsState } from './actions'
import type { SettingsForm } from '@/lib/read/settings'
import type { Currency } from '@/lib/domain/money'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

const initial: SettingsState = {}

const POOLS: Array<{ currency: Currency; name: string; note: string }> = [
  {
    currency: 'HKD',
    name: 'Hong Kong dollars',
    note: 'HSBC, Mox, ZA, Octopus, PayMe, and the credit card. Where you live, so this is the pool that wants a floor.',
  },
  {
    currency: 'USD',
    name: 'US dollars',
    note: 'ZA Bank. Set a floor only if this stops being savings and becomes money you spend.',
  },
  {
    currency: 'THB',
    name: 'Thai baht',
    note: 'Krung Thai. Set a monthly figure if you spend meaningfully in Thailand; leave it at zero and the pool simply shows its balance.',
  },
]

function toDecimal(minor: string | undefined, decimals = 2): string {
  if (!minor) return ''
  const value = BigInt(minor)
  if (value === 0n) return ''
  const factor = 10n ** BigInt(decimals)
  return `${value / factor}.${(value % factor).toString().padStart(decimals, '0')}`
}

export function AdvancedFormView({ form }: { form: SettingsForm }) {
  const [state, formAction] = useActionState(saveAdvancedSettings, initial)

  return (
    <form action={formAction} className="flex flex-col gap-10">
      <Section divided={false}>
        <div>
          <SectionHeading>Floors, per pool</SectionHeading>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The floor is <strong>days of cover</strong>, not a fixed cushion: it is your daily
            spending multiplied by the days you want to keep in reserve, so it moves on its own as
            your life gets cheaper or more expensive. The monthly figure seeds that calculation —
            once there are {form.minHistoryDays} days of history, the rule measures your real
            spending instead and says so.
          </p>
        </div>

        <div className="flex flex-col gap-6">
          {POOLS.map((pool) => (
            <div key={pool.currency} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{pool.currency}</span>
                <span className="text-sm text-muted-foreground">{pool.name}</span>
              </div>
              <p className="max-w-2xl text-xs text-muted-foreground">{pool.note}</p>

              <div className="flex flex-wrap gap-3">
                <Field>
                  <FieldLabel>Days of cover</FieldLabel>
                  <Input
                    name={`floorDays.${pool.currency}`}
                    inputMode="numeric"
                    defaultValue={form.floorDays[pool.currency] ?? 0}
                    className="tabular w-32"
                  />
                </Field>

                <Field>
                  <FieldLabel>Typical spend / month ({pool.currency})</FieldLabel>
                  <Input
                    name={`monthlySpend.${pool.currency}`}
                    inputMode="decimal"
                    defaultValue={toDecimal(form.declaredMonthlySpendMinor[pool.currency])}
                    placeholder="0.00"
                    className="tabular w-48"
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section divided={false}>
        <div>
          <SectionHeading>Timing</SectionHeading>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            How far ahead scheduled bills count against you, how much spending history the burn
            rate averages over, and how much history it needs before it trusts that average over
            your declared figure.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Field>
            <FieldLabel>Committed horizon (days)</FieldLabel>
            <Input
              name="horizonDays"
              inputMode="numeric"
              defaultValue={form.horizonDays}
              className="tabular w-40"
            />
          </Field>
          <Field>
            <FieldLabel>Burn window (days)</FieldLabel>
            <Input
              name="burnWindowDays"
              inputMode="numeric"
              defaultValue={form.burnWindowDays}
              className="tabular w-40"
            />
          </Field>
          <Field>
            <FieldLabel>History before measuring</FieldLabel>
            <Input
              name="minHistoryDays"
              inputMode="numeric"
              defaultValue={form.minHistoryDays}
              className="tabular w-40"
            />
          </Field>
        </div>
      </Section>

      <Section divided={false}>
        <div>
          <SectionHeading>Gmail ingest</SectionHeading>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A parsed email at or above this confidence posts itself; below it, it waits in the{' '}
            <span className="whitespace-nowrap">review queue</span> instead. Higher is more
            cautious — more emails wait for you to confirm them.
          </p>
        </div>
        <Field>
          <FieldLabel>Auto-post confidence (0–1)</FieldLabel>
          <Input
            name="autoPostConfidence"
            inputMode="decimal"
            defaultValue={form.autoPostConfidence}
            className="tabular w-32"
          />
        </Field>
      </Section>

      <div className="flex items-center gap-4">
        <SubmitButton size="lg" className="self-start" pendingLabel="Saving…">
          Save advanced settings
        </SubmitButton>
        <FormStatus state={state} />
      </div>
    </form>
  )
}
