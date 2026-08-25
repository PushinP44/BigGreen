import { PageHeader, PageShell } from '@/components/page-shell'
import { requireSessionDb } from '@/lib/db/session'
import { formatMoney, isCurrency, money, type Currency } from '@/lib/domain/money'
import { AccountDetailsForm } from './account-details-form'
import { AccountForm, ArchiveButton } from './account-form'

export const dynamic = 'force-dynamic'

interface AccountRow {
  id: string
  name: string
  kind: string
  currency: string
  is_liquid: boolean
  institution: string | null
  account_last4: string | null
  opening_balance_minor: string
  balance_minor: string
}

export default async function AccountsPage() {
  const { db } = await requireSessionDb()

  const result = await db.query<AccountRow>(`
    SELECT
      a.id, a.name, a.kind::text AS kind, a.currency, a.is_liquid, a.institution,
      a.account_last4, a.opening_balance_minor::text AS opening_balance_minor,
      (a.opening_balance_minor
        + COALESCE(SUM(e.amount_minor) FILTER (WHERE e.currency = a.currency), 0))::text
        AS balance_minor
    FROM accounts a
    LEFT JOIN entries e
      ON e.account_id = a.id
     AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = e.transaction_id AND t.status = 'posted')
    WHERE a.is_own AND a.archived_at IS NULL
    GROUP BY a.id
    ORDER BY a.currency, a.name
  `)

  const accounts = result.rows

  return (
    <PageShell>
      <PageHeader
        title="Accounts"
        description={
          <>
            The accounts you actually hold money in. Each currency you add becomes its own pool on
            the dashboard, judged separately — money in one currency cannot pay for something in
            another without a transfer.
          </>
        }
      />

      {accounts.length === 0 ? (
        <p className="rounded-lg border border-(--color-line) px-4 py-6 text-sm text-muted-foreground">
          No accounts yet. Add the first one below — until then there is nowhere to record a
          transaction.
        </p>
      ) : (
        <ul className="flex flex-col">
          {accounts.map((account) => {
            const currency = account.currency.trim()
            return (
              <li
                key={account.id}
                className="flex flex-wrap items-baseline gap-3 border-b border-(--color-line)/60 py-2.5 text-sm"
              >
                <span className="flex-1 font-medium">
                  {account.name}
                  {account.is_liquid ? (
                    <span className="ml-2 rounded bg-(--color-green)/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-(--color-green)">
                      liquid
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">{account.kind}</span>
                <span className="tabular w-32 text-right">
                  {isCurrency(currency)
                    ? formatMoney(money(BigInt(account.balance_minor), currency as Currency))
                    : `${account.balance_minor} ${currency}`}
                </span>
                <ArchiveButton id={account.id} />
              </li>
            )
          })}
        </ul>
      )}

      {accounts.length > 0 ? (
        <section className="flex flex-col gap-4 border-t border-(--color-line) pt-8">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Account details
          </h2>
          <AccountDetailsForm
            accounts={accounts.map((account) => ({
              id: account.id,
              name: account.name,
              kind: account.kind,
              currency: account.currency,
              institution: account.institution,
              accountLast4: account.account_last4,
              openingBalanceMinor: account.opening_balance_minor,
            }))}
          />
        </section>
      ) : null}

      <section className="flex flex-col gap-4 border-t border-(--color-line) pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Add an account
        </h2>
        <AccountForm />
      </section>
    </PageShell>
  )
}
