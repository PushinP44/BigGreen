import { PageHeader, PageShell, Section } from '@/components/page-shell'
import { requireSessionDb } from '@/lib/db/session'
import { listCreditCards, loadSafetySettings } from '@/lib/read/settings'
import { AdvancedFormView } from './advanced-form'
import { CardSettings } from './cards'

export const dynamic = 'force-dynamic'

export default async function AdvancedSettingsPage() {
  const { db } = await requireSessionDb()
  const [{ form }, cards] = await Promise.all([loadSafetySettings(db), listCreditCards(db)])

  return (
    <PageShell>
      <PageHeader
        title="Advanced settings"
        description={
          <>
            Floors per pool, timing, ingest confidence, and credit card billing terms — set once
            and rarely touched again.
          </>
        }
        back={{ href: "/settings", label: "Settings" }}
      />

      <AdvancedFormView form={form} />

      <Section title="Credit cards">
        <CardSettings cards={cards} />
      </Section>
    </PageShell>
  )
}
