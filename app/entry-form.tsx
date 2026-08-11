'use client'

import { useActionState, useCallback, useMemo, useState } from 'react'
import { addTransaction, type ActionState } from './actions'
import {
  evaluatePayment,
  termsFromJson,
  type SafetyTermsJson,
  type Verdict,
} from '@/lib/domain/safety'
import { parseAmountInput, parseRate, applyRate, type Currency } from '@/lib/domain/money'

export interface AccountOption {
  readonly id: string
  readonly name: string
  readonly currency: string
}

export interface CategoryOption {
  readonly id: string
  readonly name: string
  readonly isDiscretionary: boolean
}

type Kind = 'spend' | 'income' | 'transfer'

const initial: ActionState = {}

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'spend', label: 'Spend' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
]

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)'
const label = 'text-xs uppercase tracking-wide text-(--color-muted)'

/**
 * The `+` sheet: three flows, one segmented control (PLAN §4).
 *
 * With import cut (PLAN rev 3) this is the only way data enters the ledger, so
 * entry speed is a primary feature rather than a fallback — the amount field
 * autofocuses, the account selection survives between entries, and every
 * control is reachable from the keyboard.
 */
export function EntryForm({
  accounts,
  categories,
  terms,
  rates,
}: {
  accounts: readonly AccountOption[]
  categories: readonly CategoryOption[]
  terms: SafetyTermsJson
  /** currency → HKD rate, as decimal strings. HKD is implicitly 1. */
  rates: Readonly<Record<string, string>>
}) {
  const [state, formAction, pending] = useActionState(addTransaction, initial)
  const [kind, setKind] = useState<Kind>('spend')
  const [fromId, setFromId] = useState(accounts[0]?.id ?? '')
  const [toId, setToId] = useState(accounts[1]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [categoryId, setCategoryId] = useState('')

  const currencyOf = useCallback(
    (id: string) => accounts.find((a) => a.id === id)?.currency,
    [accounts],
  )

  /**
   * Live verdict, recomputed on every keystroke by the same pure function the
   * server uses (PLAN §5). Running the real rule in both places is the point —
   * an approximate copy in the UI would drift, and a verdict you cannot trust
   * is worse than none.
   */
  const safety = useMemo(() => {
    if (kind !== 'spend' || amount.trim() === '') return null

    const currency = currencyOf(accountId)
    if (!currency) return null

    try {
      const parsed = parseAmountInput(amount, currency as Currency)
      if (parsed.amountMinor <= 0n) return null

      const rateText = currency === 'HKD' ? '1' : rates[currency]
      if (rateText === undefined) return null

      const hkdMinor =
        currency === 'HKD' ? parsed.amountMinor : applyRate(parsed, parseRate(rateText)).amountMinor

      return evaluatePayment(termsFromJson(terms), {
        amountHkdMinor: hkdMinor,
        isDiscretionary:
          categories.find((c) => c.id === categoryId)?.isDiscretionary ?? false,
      })
    } catch {
      // Mid-typing input ("12.", "-") is not an error worth shouting about;
      // the server validates properly on submit.
      return null
    }
  }, [kind, amount, accountId, categoryId, terms, rates, categories, currencyOf])
  // Only you know what the bank actually credited, so a cross-currency
  // transfer has to ask rather than apply the reference rate.
  const crossCurrency =
    kind === 'transfer' && !!fromId && !!toId && currencyOf(fromId) !== currencyOf(toId)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="kind" value={kind} />

      <div className="flex gap-1 rounded-lg border border-(--color-line) p-1 self-start">
        {KINDS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setKind(option.value)}
            aria-pressed={kind === option.value}
            className={`rounded-md px-4 py-1.5 text-sm transition ${
              kind === option.value
                ? 'bg-(--color-green) text-white'
                : 'text-(--color-muted) hover:text-(--color-ink) dark:hover:text-white'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 min-w-32">
          <span className={label}>Amount</span>
          <input
            name="amount"
            inputMode="decimal"
            autoFocus
            required
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className={`tabular text-lg ${field}`}
          />
        </label>

        {kind === 'transfer' ? (
          <>
            <label className="flex flex-col gap-1">
              <span className={label}>From</span>
              <select
                name="fromAccountId"
                value={fromId}
                onChange={(event) => setFromId(event.target.value)}
                className={`text-lg ${field}`}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className={label}>To</span>
              <select
                name="toAccountId"
                value={toId}
                onChange={(event) => setToId(event.target.value)}
                className={`text-lg ${field}`}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className={label}>Account</span>
              <select
                name="accountId"
                required
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className={`text-lg ${field}`}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
            </label>

            {kind === 'spend' ? (
              <label className="flex flex-col gap-1">
                <span className={label}>Category</span>
                <select
                  name="categoryId"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                  className={`text-lg ${field}`}
                >
                  <option value="">Uncategorised</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        )}
      </div>

      {crossCurrency ? (
        <label className="flex flex-col gap-1 max-w-xs">
          <span className={label}>Amount received ({currencyOf(toId)})</span>
          <input
            name="toAmount"
            inputMode="decimal"
            required
            placeholder="0.00"
            className={`tabular text-lg ${field}`}
          />
          <span className="text-xs text-(--color-muted)">
            What actually landed. The difference against the reference rate is your bank&rsquo;s
            spread and is booked to FX Gain/Loss.
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1 min-w-48">
          <span className={label}>Description</span>
          <input name="description" placeholder="Lunch, MTR, salary…" className={field} />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-(--color-green) px-5 py-2.5 font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
        >
          {pending ? 'Recording…' : 'Record'}
        </button>
      </div>

      {safety ? <VerdictBadge verdict={safety.verdict} reason={safety.reason} /> : null}

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.ok ? <p className="text-sm text-(--color-green)">{state.ok}</p> : null}
    </form>
  )
}

const VERDICT_STYLE: Record<Verdict, string> = {
  SAFE: 'border-(--color-green)/40 bg-(--color-green)/8 text-(--color-green)',
  CAUTION: 'border-amber-500/40 bg-amber-500/8 text-amber-600 dark:text-amber-400',
  UNSAFE: 'border-red-500/40 bg-red-500/8 text-red-600 dark:text-red-400',
}

/**
 * The verdict always ships with its reason. A red badge and nothing else gets
 * ignored within a week (PLAN §5), so the numbers behind the decision are on
 * screen at the moment of the decision.
 */
function VerdictBadge({ verdict, reason }: { verdict: Verdict; reason: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col gap-1 rounded-lg border px-4 py-3 ${VERDICT_STYLE[verdict]}`}
    >
      <span className="text-xs font-semibold uppercase tracking-wider">{verdict}</span>
      <span className="text-sm text-(--color-ink)">{reason}</span>
    </div>
  )
}
