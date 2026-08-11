import { getDb } from '@/lib/db/client'
import { formatMoney, money } from '@/lib/domain/money'
import { listAccountBalances, liquidTotalHkdMinor } from '@/lib/read/accounts'
import { EntryForm } from './entry-form'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const db = await getDb()
  const accounts = await listAccountBalances(db)

  const own = accounts.filter((a) => a.isOwn)
  const system = accounts.filter((a) => !a.isOwn)
  const liquid = liquidTotalHkdMinor(accounts)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Big Green</h1>
        <p className="text-sm text-(--color-muted)">
          Personal money tracker · base currency HKD · P0 slice
        </p>
      </header>

      <section className="flex flex-col gap-1 rounded-xl border border-(--color-line) p-6">
        <span className="text-xs uppercase tracking-wide text-(--color-muted)">
          Liquid, owned accounts
        </span>
        <span className="tabular text-4xl font-semibold">
          {formatMoney(money(liquid, 'HKD'))}
        </span>
        <span className="text-xs text-(--color-muted)">
          The <code>liquid</code> term of the safety rule. Committed outflows, the emergency
          floor and the safe-to-spend verdict arrive in P2.
        </span>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
          Record a transaction
        </h2>
        <EntryForm
          accounts={own.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        />
      </section>

      <AccountTable title="Your accounts" accounts={own} />
      {/*
        System accounts receive entries in every currency, so their native
        balance is only part of the story. Show HKD, which is always complete.
      */}
      <AccountTable title="System accounts" accounts={system} forceHkd />
    </main>
  )
}

function AccountTable({
  title,
  accounts,
  forceHkd = false,
}: {
  title: string
  accounts: Awaited<ReturnType<typeof listAccountBalances>>
  forceHkd?: boolean
}) {
  if (accounts.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-(--color-line) text-left text-xs uppercase tracking-wide text-(--color-muted)">
              <th className="py-2 pr-4 font-medium">Account</th>
              <th className="py-2 pr-4 font-medium">Kind</th>
              <th className="py-2 pr-4 text-right font-medium">Balance</th>
              {forceHkd ? null : <th className="py-2 text-right font-medium">HKD</th>}
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id} className="border-b border-(--color-line)/60">
                <td className="py-2 pr-4">
                  {account.name}
                  {account.isLiquid ? (
                    <span className="ml-2 rounded bg-(--color-green)/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-(--color-green)">
                      liquid
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-4 text-(--color-muted)">{account.kind}</td>
                <td className="tabular py-2 pr-4 text-right">
                  {forceHkd
                    ? formatMoney(money(account.balanceHkdMinor, 'HKD'))
                    : formatMoney(money(account.balanceMinor, account.currency))}
                </td>
                {forceHkd ? null : (
                  <td className="tabular py-2 text-right text-(--color-muted)">
                    {account.currency === 'HKD'
                      ? '—'
                      : formatMoney(money(account.balanceHkdMinor, 'HKD'))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
