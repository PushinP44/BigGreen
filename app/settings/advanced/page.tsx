import Link from 'next/link'
import { requireSessionDb } from '@/lib/db/session'
import { listCreditCards, loadSafetySettings } from '@/lib/read/settings'
import { AdvancedFormView } from './advanced-form'
import { CardSettings } from './cards'

export const dynamic = 'force-dynamic'

export default async function AdvancedSettingsPage() {
  const { db } = await requireSessionDb()
  const [{ form }, cards] = await Promise.all([loadSafetySettings(db), listCreditCards(db)])

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-1">
        <Link
          href="/settings"
          className="text-xs uppercase tracking-wide text-muted-foreground hover:text-(--color-green)"
        >
          ← Settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Advanced settings</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Floors per pool, timing, ingest confidence, and credit card billing terms — set once
          and rarely touched again.
        </p>
      </header>

      <AdvancedFormView form={form} />

      <section className="flex flex-col gap-4 border-t border-(--color-line) pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Credit cards
        </h2>
        <CardSettings cards={cards} />
      </section>
    </main>
  )
}
