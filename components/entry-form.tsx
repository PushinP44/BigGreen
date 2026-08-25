'use client'

import { useActionState, useCallback, useMemo, useState } from 'react'
// The *extended* ActionState: `addTransaction` also reports the direction of
// the posted transaction, which is what drives the 💵 flourish below.
import { addTransaction, type ActionState } from '@/app/actions'
import { TransactionEffects, type EffectTrigger } from './transaction-effects'
import { FormStatus } from './form-status'
import { SubmitButton } from './submit-button'
import { Field, FieldHint, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Alert } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
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

const KINDS: ReadonlyArray<{ readonly value: Kind; readonly label: string }> = [
  { value: 'spend', label: 'Spend' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
]

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
  const [state, formAction] = useActionState(addTransaction, initial)
  const [kind, setKind] = useState<Kind>('spend')
  const [fromId, setFromId] = useState(accounts[0]?.id ?? '')
  const [toId, setToId] = useState(accounts[1]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [categoryId, setCategoryId] = useState('')
  const [effectTrigger, setEffectTrigger] = useState<EffectTrigger | null>(null)
  const [handledState, setHandledState] = useState<ActionState>(initial)

  // Adjust state during render, not in an effect (react-hooks/set-state-in-
  // effect) — React's own sanctioned pattern for "do something once when a
  // value changes". `useActionState` hands back a fresh `state` object on
  // every completed submission (never the stable `initial` one), so tracking
  // the last-handled object is what makes this fire exactly once per
  // successful save rather than on every render.
  if (state !== handledState) {
    setHandledState(state)
    if (state.ok && state.direction) {
      const direction = state.direction
      setEffectTrigger((previous) => ({ direction, token: (previous?.token ?? 0) + 1 }))
    }
  }

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

      // The HKD figure is only for the blended discretionary budget; the
      // affordability check happens entirely inside the payment's own pool.
      const rateText = currency === 'HKD' ? '1' : rates[currency]
      const hkdMinor =
        currency === 'HKD'
          ? parsed.amountMinor
          : rateText === undefined
            ? 0n
            : applyRate(parsed, parseRate(rateText)).amountMinor

      return evaluatePayment(termsFromJson(terms), {
        amountMinor: parsed.amountMinor,
        currency: currency as Currency,
        amountHkdMinor: hkdMinor,
        isDiscretionary: categories.find((c) => c.id === categoryId)?.isDiscretionary ?? false,
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
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="kind" value={kind} />

      <Segmented options={KINDS} value={kind} onChange={setKind} label="Transaction kind" />

      <div className="flex flex-wrap gap-4">
        <Field className="min-w-32 flex-1">
          <FieldLabel>Amount</FieldLabel>
          <Input
            name="amount"
            inputMode="decimal"
            autoFocus
            required
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            // The amount is the one figure on this form worth setting in
            // display type — it is what the whole verdict below turns on.
            className="tabular h-11 text-xl font-semibold tracking-tight md:text-xl"
          />
        </Field>

        {kind === 'transfer' ? (
          <>
            <Field>
              <FieldLabel>From</FieldLabel>
              <Select
                name="fromAccountId"
                value={fromId}
                onChange={(event) => setFromId(event.target.value)}
                className="h-11"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </Select>
            </Field>

            <Field>
              <FieldLabel>To</FieldLabel>
              <Select
                name="toAccountId"
                value={toId}
                onChange={(event) => setToId(event.target.value)}
                className="h-11"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : (
          <>
            <Field>
              <FieldLabel>Account</FieldLabel>
              <Select
                name="accountId"
                required
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="h-11"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </Select>
            </Field>

            {kind === 'spend' ? (
              <Field>
                <FieldLabel>Category</FieldLabel>
                <Select
                  name="categoryId"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                  className="h-11"
                >
                  <option value="">Uncategorised</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </>
        )}
      </div>

      {crossCurrency ? (
        <Field className="max-w-xs">
          <FieldLabel>Amount received ({currencyOf(toId)})</FieldLabel>
          <Input name="toAmount" inputMode="decimal" required placeholder="0.00" className="tabular" />
          <FieldHint>
            What actually landed. The difference against the reference rate is your bank&rsquo;s
            spread and is booked to FX Gain/Loss.
          </FieldHint>
        </Field>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-48 flex-1">
          <FieldLabel>Description</FieldLabel>
          <Input name="description" placeholder="Lunch, MTR, salary…" />
        </Field>

        <SubmitButton size="lg" pendingLabel="Recording…">
          Record
        </SubmitButton>
      </div>

      {safety ? <VerdictBadge verdict={safety.verdict} reason={safety.reason} /> : null}

      <FormStatus state={state} />

      <TransactionEffects trigger={effectTrigger} />
    </form>
  )
}

const VERDICT_VARIANT: Record<Verdict, 'success' | 'warning' | 'destructive'> = {
  SAFE: 'success',
  CAUTION: 'warning',
  UNSAFE: 'destructive',
}

const VERDICT_LABEL_COLOR: Record<Verdict, string> = {
  SAFE: 'text-primary',
  CAUTION: 'text-warning',
  UNSAFE: 'text-destructive',
}

/**
 * The verdict always ships with its reason. A red badge and nothing else gets
 * ignored within a week (PLAN §5), so the numbers behind the decision are on
 * screen at the moment of the decision.
 */
function VerdictBadge({ verdict, reason }: { verdict: Verdict; reason: string }) {
  return (
    <Alert
      variant={VERDICT_VARIANT[verdict]}
      // Overrides the `role="alert"` that `variant="destructive"` would
      // otherwise apply. This recomputes on every keystroke, and an assertive
      // live region would interrupt the screen reader mid-word each time —
      // polite is the only usable register for a running verdict.
      role="status"
      aria-live="polite"
    >
      <span
        className={cn(
          'text-xs font-semibold uppercase tracking-wider',
          VERDICT_LABEL_COLOR[verdict],
        )}
      >
        {verdict}
      </span>
      <span className="text-sm text-foreground">{reason}</span>
    </Alert>
  )
}
