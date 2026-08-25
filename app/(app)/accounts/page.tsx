import { PageHeader, PageShell, Section } from '@/components/page-shell'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
        <p className="rounded-lg border border-border px-4 py-6 text-sm text-muted-foreground">
          No accounts yet. Add the first one below — until then there is nowhere to record a
          transaction.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => {
              const currency = account.currency.trim()
              return (
                <TableRow key={account.id}>
                  <TableCell className="font-medium">
                    {account.name}
                    {account.is_liquid ? (
                      <Badge variant="success" className="ml-2">
                        liquid
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{account.kind}</TableCell>
                  <TableCell className="tabular whitespace-nowrap text-right">
                    {isCurrency(currency)
                      ? formatMoney(money(BigInt(account.balance_minor), currency as Currency))
                      : `${account.balance_minor} ${currency}`}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <ArchiveButton id={account.id} />
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {accounts.length > 0 ? (
        <Section title="Account details">
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
        </Section>
      ) : null}

      <Section title="Add an account">
        <AccountForm />
      </Section>

    </PageShell>
  )
}
