import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
import { formatMoney, money, isCurrency, type Currency } from '@/lib/domain/money'
import { zonedParts } from '@/lib/domain/clock'
import { PendingRow } from './pending-row'

export const dynamic = 'force-dynamic'

interface PendingTransaction {
  id: string
  occurred_at: string
  description: string | null
  merchant: string | null
  notes: string | null
  account_name: string
  account_currency: string
  native_minor: string
}

export default async function ReviewPage() {
  const { db } = await requireSessionDb()

  const result = await db.query<PendingTransaction>(`
    SELECT DISTINCT ON (t.id)
      t.id, t.occurred_at, t.description, t.merchant, t.notes,
      a.name AS account_name, a.currency AS account_currency,
      e.amount_minor::text AS native_minor
    FROM transactions t
    JOIN entries  e ON e.transaction_id = t.id
    JOIN accounts a ON a.id = e.account_id
    WHERE t.status = 'pending' AND a.is_own
    ORDER BY t.id, abs(e.amount_hkd_minor) DESC
  `)

  const pending = result.rows

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-1">
        <Link
          href="/"
          className="text-xs uppercase tracking-wide text-(--color-muted) hover:text-(--color-green)"
        >
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Needs review</h1>
        <p className="max-w-2xl text-sm text-(--color-muted)">
          Emails the parser read but was not confident enough to post on its own. Each one says
          what it was unsure about — an empty queue means the parsers are doing their job, and a
          growing one means a parser needs a look.
        </p>
      </header>

      {pending.length === 0 ? (
        <p className="rounded-lg border border-(--color-line) px-4 py-6 text-center text-sm text-(--color-muted)">
          Nothing waiting.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((row) => {
            const currency = row.account_currency.trim()
            return (
              <PendingRow
                key={row.id}
                id={row.id}
                date={shortDate(new Date(row.occurred_at))}
                description={row.description ?? row.merchant ?? 'No description'}
                accountName={row.account_name}
                amount={
                  isCurrency(currency)
                    ? formatMoney(money(BigInt(row.native_minor), currency as Currency))
                    : `${row.native_minor} ${currency}`
                }
                notes={row.notes ?? ''}
              />
            )
          })}
        </ul>
      )}
    </main>
  )
}

function shortDate(date: Date): string {
  const parts = zonedParts(date)
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}`
}
