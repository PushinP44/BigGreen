'use client'

import { useActionState } from 'react'
import { saveSettings, type SettingsState } from './actions'
import type { SettingsForm } from '@/lib/read/settings'

const initial: SettingsState = {}

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)'
const label = 'text-xs uppercase tracking-wide text-(--color-muted)'

function toDecimal(minor: string | undefined, decimals = 2): string {
  if (!minor) return ''
  const value = BigInt(minor)
  if (value === 0n) return ''
  const factor = 10n ** BigInt(decimals)
  return `${value / factor}.${(value % factor).toString().padStart(decimals, '0')}`
}

export function SettingsFormView({ form }: { form: SettingsForm }) {
  const [state, formAction, pending] = useActionState(saveSettings, initial)

  return (
    <form action={formAction} className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
            Discretionary budget
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-(--color-muted)">
            The CAUTION band: affordable, but over what you meant to spend. Counted in HKD across
            every pool — liquidity is per currency because you cannot spend baht in Hong Kong, but
            a budget is about habits, and eating out in Bangkok is the same habit as eating out in
            Kowloon.
          </p>
        </div>

        <label className="flex max-w-xs flex-col gap-1">
          <span className={label}>HKD per month</span>
          <input
            name="discretionaryBudget"
            inputMode="decimal"
            required
            defaultValue={toDecimal(form.discretionaryBudgetHkdMinor)}
            placeholder="3000.00"
            className={`tabular text-lg ${field}`}
          />
          {form.usingDefaults['safety.discretionary_budget'] ? (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              Still the placeholder. This is the number you said you would set yourself.
            </span>
          ) : null}
        </label>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
            Credit cards
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-(--color-muted)">
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
              className="mt-1"
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
              className="mt-1"
            />
            <span className="text-sm">
              <strong>Full balance</strong> — for clearing the card monthly, when the balance
              really is next month&rsquo;s outflow. More conservative.
            </span>
          </label>
        </div>
      </section>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-(--color-green) px-5 py-2.5 font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        {state.error ? (
          <span role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </span>
        ) : null}
        {state.ok ? <span className="text-sm text-(--color-green)">{state.ok}</span> : null}
      </div>
    </form>
  )
}
