'use client'

import { useActionState } from 'react'
import { saveAdvancedSettings, type SettingsState } from './actions'
import type { SettingsForm } from '@/lib/read/settings'
import type { Currency } from '@/lib/domain/money'

const initial: SettingsState = {}

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)'
const label = 'text-xs uppercase tracking-wide text-muted-foreground'

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
  const [state, formAction, pending] = useActionState(saveAdvancedSettings, initial)

  return (
    <form action={formAction} className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Floors, per pool
          </h2>
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
                <label className="flex flex-col gap-1">
                  <span className={label}>Days of cover</span>
                  <input
                    name={`floorDays.${pool.currency}`}
                    inputMode="numeric"
                    defaultValue={form.floorDays[pool.currency] ?? 0}
                    className={`tabular w-32 ${field}`}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className={label}>Typical spend / month ({pool.currency})</span>
                  <input
                    name={`monthlySpend.${pool.currency}`}
                    inputMode="decimal"
                    defaultValue={toDecimal(form.declaredMonthlySpendMinor[pool.currency])}
                    placeholder="0.00"
                    className={`tabular w-48 ${field}`}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Timing
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            How far ahead scheduled bills count against you, how much spending history the burn
            rate averages over, and how much history it needs before it trusts that average over
            your declared figure.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1">
            <span className={label}>Committed horizon (days)</span>
            <input
              name="horizonDays"
              inputMode="numeric"
              defaultValue={form.horizonDays}
              className={`tabular w-40 ${field}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Burn window (days)</span>
            <input
              name="burnWindowDays"
              inputMode="numeric"
              defaultValue={form.burnWindowDays}
              className={`tabular w-40 ${field}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>History before measuring</span>
            <input
              name="minHistoryDays"
              inputMode="numeric"
              defaultValue={form.minHistoryDays}
              className={`tabular w-40 ${field}`}
            />
          </label>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Gmail ingest
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A parsed email at or above this confidence posts itself; below it, it waits in the{' '}
            <span className="whitespace-nowrap">review queue</span> instead. Higher is more
            cautious — more emails wait for you to confirm them.
          </p>
        </div>
        <label className="flex flex-col gap-1">
          <span className={label}>Auto-post confidence (0–1)</span>
          <input
            name="autoPostConfidence"
            inputMode="decimal"
            defaultValue={form.autoPostConfidence}
            className={`tabular w-32 ${field}`}
          />
        </label>
      </section>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-(--color-green) px-5 py-2.5 font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save advanced settings'}
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
