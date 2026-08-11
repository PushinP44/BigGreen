import 'server-only'

/**
 * Full data export — every transaction and every entry.
 *
 * PLAN §14 names an abandoned half-built ledger as the most likely failure mode
 * of this project. This is the hedge: whatever happens, the data walks out in a
 * format any spreadsheet or successor tool can read. Deliberately complete
 * rather than pretty — including the FX rate frozen on each entry, without
 * which the HKD figures could not be reconstructed.
 */

import type { Db } from '@/lib/db/client'

export interface ExportRow {
  transaction_id: string
  occurred_at: string
  status: string
  source: string
  description: string | null
  merchant: string | null
  category: string | null
  notes: string | null
  account: string
  account_kind: string
  amount_minor: string
  currency: string
  fx_rate_to_hkd: string
  amount_hkd_minor: string
  is_fx_residual: boolean
}

/**
 * Everything is cast to text in SQL rather than trusting the driver's
 * JavaScript mapping. `int8` would otherwise arrive as a `number` — lossy past
 * 2^53 and inconsistent with the CSV — and `timestamptz` as a `Date` that
 * stringifies to "Wed Aug 12 2026 … (Hong Kong Standard Time)", which nothing
 * downstream can parse back.
 */
export async function buildExportRows(db: Db): Promise<ExportRow[]> {
  const result = await db.query<ExportRow>(`
    SELECT
      t.id                                    AS transaction_id,
      to_char(t.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                                              AS occurred_at,
      t.status::text                          AS status,
      t.source::text                          AS source,
      t.description,
      t.merchant,
      c.name                                  AS category,
      t.notes,
      a.name                                  AS account,
      a.kind::text                            AS account_kind,
      e.amount_minor::text                    AS amount_minor,
      e.currency,
      e.fx_rate_to_hkd::text                  AS fx_rate_to_hkd,
      e.amount_hkd_minor::text                AS amount_hkd_minor,
      e.is_fx_residual
    FROM entries e
    JOIN transactions t ON t.id = e.transaction_id
    JOIN accounts    a ON a.id = e.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    ORDER BY t.occurred_at DESC, t.id, a.name
  `)

  return result.rows
}

export const EXPORT_COLUMNS: Array<keyof ExportRow> = [
  'transaction_id',
  'occurred_at',
  'status',
  'source',
  'description',
  'merchant',
  'category',
  'notes',
  'account',
  'account_kind',
  'amount_minor',
  'currency',
  'fx_rate_to_hkd',
  'amount_hkd_minor',
  'is_fx_residual',
]

export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

/**
 * RFC 4180 quoting. A description containing a comma, a quote or a newline is
 * ordinary — "Lunch, 2 people" would otherwise silently shift every later
 * column in that row.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}
