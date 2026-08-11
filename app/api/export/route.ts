import { getDb } from '@/lib/db/client'
import { toLocalDate } from '@/lib/domain/clock'
import { buildExportRows, toCsv } from '@/lib/read/export'

/**
 * Thin wrapper. Everything that could be wrong — serialisation fidelity, CSV
 * quoting — lives in `lib/read/export.ts` where it is tested.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const format = new URL(request.url).searchParams.get('format') === 'json' ? 'json' : 'csv'

  const db = await getDb()
  const rows = await buildExportRows(db)
  const stamp = toLocalDate(new Date())

  if (format === 'json') {
    return Response.json(
      { exportedAt: new Date().toISOString(), baseCurrency: 'HKD', entries: rows },
      { headers: { 'Content-Disposition': `attachment; filename="big-green-${stamp}.json"` } },
    )
  }

  return new Response(toCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="big-green-${stamp}.csv"`,
    },
  })
}
