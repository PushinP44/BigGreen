'use client'

import { useActionState } from 'react'
import { money, toDecimalString, type Currency } from '@/lib/domain/money'
import { updateAccountDetails, type AccountState } from './actions'

export interface AccountDetailRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly currency: string
  readonly accountLast4: string | null
  readonly openingBalanceMinor: string
}

const initial: AccountState = {}

const field =
  'rounded-md border border-(--color-line) bg-transparent px-3 py-2 outline-none focus:border-(--color-green)'
const label = 'text-xs uppercase tracking-wide text-(--color-muted)'

/**
 * The balance an account already held before you started tracking it here,
 * and the digits its emailed alerts show — the only way to set either on an
 * account that already exists, since `createAccount` only asks at creation.
 * One form, one save, every account — same shape as `CardSettings` in
 * settings/advanced, generalised past credit cards.
 */
export function AccountDetailsForm({ accounts }: { accounts: readonly AccountDetailRow[] }) {
  const [state, formAction, pending] = useActionState(updateAccountDetails, initial)

  if (accounts.length === 0) return null

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-(--color-muted)">
        Set what an account held before you started tracking it here, and the digits from its
        emailed alerts — the front four of the account number, or the back four for a card.
        Leave the digits blank if it never emails you.
      </p>

      <div className="flex flex-col gap-3">
        {accounts.map((account) => {
          const currency = account.currency.trim() as Currency
          const defaultBalance = toDecimalString(money(BigInt(account.openingBalanceMinor), currency))
          return (
            <div
              key={account.id}
              className="flex flex-wrap items-end gap-3 rounded-lg border border-(--color-line) p-3"
            >
              <input type="hidden" name="accountIds" value={account.id} />
              <span className="min-w-32 self-center text-sm font-medium">
                {account.name}
                <span className="ml-2 text-xs font-normal text-(--color-muted)">{currency}</span>
              </span>

              <label className="flex flex-col gap-1">
                <span className={label}>Opening balance</span>
                <input
                  name={`openingBalance.${account.id}`}
                  inputMode="decimal"
                  placeholder="0.00"
                  defaultValue={defaultBalance}
                  className={`tabular w-36 ${field}`}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className={label}>
                  {account.kind === 'credit_card' ? 'Card ends in' : 'Account starts with'}
                </span>
                <input
                  name={`accountDigits.${account.id}`}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={account.kind === 'credit_card' ? '4321' : '1234'}
                  defaultValue={account.accountLast4 ?? ''}
                  className={`tabular w-28 ${field}`}
                />
              </label>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-(--color-green) px-5 py-2.5 font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save details'}
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
