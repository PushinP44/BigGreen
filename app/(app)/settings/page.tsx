import Link from 'next/link'
import { PageHeader, PageShell } from '@/components/page-shell'
import { requireSessionDb } from '@/lib/db/session'
import { loadSafetySettings } from '@/lib/read/settings'
import { SettingsFormView } from './settings-form'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { db } = await requireSessionDb()
  const { form } = await loadSafetySettings(db)

  return (
    <PageShell>
      <PageHeader
        title="Settings"
        description={
          <>
            Every threshold the safety rule uses lives here rather than in the code. Changes are
            versioned, so a verdict you saw last month still reflects the rule that was in force
            when you saw it.
          </>
        }
      />

      <SettingsFormView form={form} />

      <p className="border-t border-border pt-6 text-sm text-muted-foreground">
        Floors per pool, credit card billing terms, and other less-common settings live on the{' '}
        <Link href="/settings/advanced" className="text-primary underline">
          advanced settings
        </Link>{' '}
        page.
      </p>
    </PageShell>
  )
}
