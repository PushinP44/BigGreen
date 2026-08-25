'use client'

import { useActionState } from 'react'
import { money, toDecimalString, type Currency } from '@/lib/domain/money'
import { updateAccountDetails, type AccountState } from './actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export interface AccountDetailRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly currency: string
  readonly institution: string | null
  readonly accountLast4: string | null
  readonly openingBalanceMinor: string
}

const initial: AccountState = {}

/**
 * The institution, the balance an account already held before you started
 * tracking it here, and the digits its emailed alerts show — the only way
 * to set any of the three on an account that already exists, since
 * `createAccount` only asks at creation. One form, one save, every account
 * — same shape as `CardSettings` in settings/advanced, generalised past
 * credit cards.
 */
export function AccountDetailsForm({ accounts }: { accounts: readonly AccountDetailRow[] }) {
  const [state, formAction] = useActionState(updateAccountDetails, initial)

  if (accounts.length === 0) return null

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Set the institution that emails this account (matches alerts to it), what it held before
        you started tracking it here, and the digits from its emailed alerts — the front four of
        the account number, or the back four for a card. Leave institution and digits blank if it
        never emails you.
      </p>

      <div className="flex flex-col gap-3">
        {accounts.map((account) => {
          const currency = account.currency.trim() as Currency
          const defaultBalance = toDecimalString(money(BigInt(account.openingBalanceMinor), currency))
          return (
            <div
              key={account.id}
              className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3"
            >
              <input type="hidden" name="accountIds" value={account.id} />
              <span className="min-w-32 self-center text-sm font-medium">
                {account.name}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{currency}</span>
              </span>

              <Field>
                <FieldLabel>Institution</FieldLabel>
                <Input
                  name={`institution.${account.id}`}
                  placeholder="hsbc"
                  defaultValue={account.institution ?? ''}
                  className="w-32"
                />
              </Field>

              <Field>
                <FieldLabel>Opening balance</FieldLabel>
                <Input
                  name={`openingBalance.${account.id}`}
                  inputMode="decimal"
                  placeholder="0.00"
                  defaultValue={defaultBalance}
                  className="tabular w-36"
                />
              </Field>

              <Field>
                <FieldLabel>
                  {account.kind === 'credit_card' ? 'Card ends in' : 'Account starts with'}
                </FieldLabel>
                <Input
                  name={`accountDigits.${account.id}`}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={account.kind === 'credit_card' ? '4321' : '1234'}
                  defaultValue={account.accountLast4 ?? ''}
                  className="tabular w-28"
                />
              </Field>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-4">
        <SubmitButton size="lg" className="self-start" pendingLabel="Saving…">
          Save details
        </SubmitButton>
        <FormStatus state={state} />
      </div>
    </form>
  )
}
