'use client'

import { useActionState } from 'react'
import { saveSettings, type SettingsState } from './actions'
import type { SettingsForm } from '@/lib/read/settings'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Section, SectionHeading } from '@/components/page-shell'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

const initial: SettingsState = {}

function toDecimal(minor: string | undefined, decimals = 2): string {
  if (!minor) return ''
  const value = BigInt(minor)
  if (value === 0n) return ''
  const factor = 10n ** BigInt(decimals)
  return `${value / factor}.${(value % factor).toString().padStart(decimals, '0')}`
}

export function SettingsFormView({ form }: { form: SettingsForm }) {
  const [state, formAction] = useActionState(saveSettings, initial)

  return (
    <form action={formAction} className="flex flex-col gap-10">
      <Section divided={false}>
        <div>
          <SectionHeading>Discretionary budget</SectionHeading>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The CAUTION band: affordable, but over what you meant to spend. Counted in HKD across
            every pool — liquidity is per currency because you cannot spend baht in Hong Kong, but
            a budget is about habits, and eating out in Bangkok is the same habit as eating out in
            Kowloon.
          </p>
        </div>

        <Field className="max-w-xs">
          <FieldLabel>HKD per month</FieldLabel>
          <Input
            name="discretionaryBudget"
            inputMode="decimal"
            required
            defaultValue={toDecimal(form.discretionaryBudgetHkdMinor)}
            placeholder="3000.00"
            className="tabular h-11 text-lg md:text-lg"
          />
          {form.usingDefaults['safety.discretionary_budget'] ? (
            <span className="text-xs text-warning">
              Still the placeholder. This is the number you said you would set yourself.
            </span>
          ) : null}
        </Field>
      </Section>

      <Section divided={false}>
        <div>
          <SectionHeading>Credit cards</SectionHeading>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            How much of a card balance competes with your rent for the same cash. Either way the
            whole balance still reduces net worth, so the gentler option cannot make you look
            richer — only more liquid, which is the truth.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-3">
            <input
              type="radio"
              name="creditModel"
              value="minimum_payment"
              defaultChecked={form.creditModel === 'minimum_payment'}
              className="mt-1 size-4 accent-primary"
            />
            <span className="text-sm">
              <strong>Minimum payment</strong> — for carrying a balance. Only what must be paid by
              the due date counts. Treating a long-carried balance as due within 30 days would
              report nothing available, every day, forever.
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="radio"
              name="creditModel"
              value="full_balance"
              defaultChecked={form.creditModel === 'full_balance'}
              className="mt-1 size-4 accent-primary"
            />
            <span className="text-sm">
              <strong>Full balance</strong> — for clearing the card monthly, when the balance
              really is next month&rsquo;s outflow. More conservative.
            </span>
          </label>
        </div>
      </Section>

      <div className="flex items-center gap-4">
        <SubmitButton size="lg" className="self-start" pendingLabel="Saving…">
          Save settings
        </SubmitButton>
        <FormStatus state={state} />
      </div>
    </form>
  )
}
