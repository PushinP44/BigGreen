'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { voidPositionAction, type PortfolioActionState } from './actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const initial: PortfolioActionState = {}

export interface PositionListRow {
  readonly transactionId: string
  readonly date: string
  readonly mode: 'buy' | 'sell' | 'legacy'
  readonly symbol: string
  readonly accountName: string
  readonly quantity: string
  readonly amount: string
  readonly description: string | null
}

const MODE_LABEL: Record<PositionListRow['mode'], string> = {
  buy: 'Buy',
  sell: 'Sell',
  legacy: 'Legacy',
}

function PositionRow({ row }: { row: PositionListRow }) {
  const [state, formAction] = useActionState(voidPositionAction, initial)

  return (
    <TableRow>
      <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">
        {row.date}
      </TableCell>
      <TableCell>
        <Badge>{MODE_LABEL[row.mode]}</Badge>
      </TableCell>
      <TableCell>
        <span className="font-medium">{row.symbol}</span>
        {/*
          The note rides under the symbol rather than taking a column of its
          own — it is present on a minority of rows and would otherwise be an
          empty column pushing the figures off a narrow screen.
        */}
        {row.description ? (
          <span className="block text-xs text-muted-foreground">{row.description}</span>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {row.accountName}
      </TableCell>
      <TableCell className="tabular whitespace-nowrap text-right text-muted-foreground">
        {row.quantity}
      </TableCell>
      <TableCell className="tabular whitespace-nowrap text-right font-medium">
        {row.amount}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1.5">
          <Button asChild variant="outline" size="xs">
            <Link href={`/portfolio?edit=${row.transactionId}#position-form`}>Edit</Link>
          </Button>
          <form action={formAction}>
            <input type="hidden" name="transactionId" value={row.transactionId} />
            <SubmitButton variant="outlineDestructive" size="xs" pendingLabel="…">
              Remove
            </SubmitButton>
          </form>
        </div>
        <FormStatus state={state} className="block pt-1 text-right" />
      </TableCell>
    </TableRow>
  )
}

/**
 * Every buy/sell/legacy entry, not just a recent handful — a position stuck
 * outside some arbitrary window would otherwise be un-editable forever with
 * no way to reach it. Edit jumps to the form below, pre-filled; Remove voids
 * the transaction outright, for when you'd rather just delete the typo'd
 * entry and start fresh. Neither ever edits a posted entry's amount in place
 * (same convention as `/review`'s discard) — Edit's "Save changes" voids the
 * old transaction and records the new one server-side
 * (lib/ledger/instruments.ts), it only looks like an edit here.
 *
 * A table rather than the stack of bordered cards this was: these rows are
 * read by scanning one column at a time — quantity against quantity, amount
 * against amount — which cards actively prevent.
 *
 * Scrolls within its own bounded height rather than growing the page
 * without limit once there are enough entries to matter.
 */
export function PositionList({ rows }: { rows: readonly PositionListRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No positions recorded yet.</p>
  }

  return (
    <div className="max-h-[32rem] overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Instrument</TableHead>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <PositionRow key={row.transactionId} row={row} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
