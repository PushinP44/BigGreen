import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
import { listCreditCards, loadSafetySettings } from '@/lib/read/settings'
import { SettingsFormView } from './settings-form'
import { CardSettings } from './cards'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { db } = await requireSessionDb()
  const [{ form }, cards] = await Promise.all([loadSafetySettings(db), listCreditCards(db)])

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-xs uppercase tracking-wide text-(--color-muted) hover:text-(--color-green)">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="max-w-2xl text-sm text-(--color-muted)">
          Every threshold the safety rule uses lives here rather than in the code. Changes are
          versioned, so a verdict you saw last month still reflects the rule that was in force
          when you saw it.
        </p>
      </header>

      <SettingsFormView form={form} />

      <section className="flex flex-col gap-4 border-t border-(--color-line) pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted)">
          Credit cards
        </h2>
        <CardSettings cards={cards} />
      </section>
    </main>
  )
}
