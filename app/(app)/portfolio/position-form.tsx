'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import {
  recordLegacyPositionAction,
  recordTradeAction,
  type PortfolioActionState,
} from './actions'
import { FormStatus } from '@/components/form-status'
import { SubmitButton } from '@/components/submit-button'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'

const initial: PortfolioActionState = {}

type Mode = 'buy' | 'sell' | 'legacy'

const MODES: ReadonlyArray<{ readonly value: Mode; readonly label: string }> = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
  { value: 'legacy', label: 'Legacy position' },
]

export interface InstrumentOption {
  readonly id: string
  readonly symbol: string
  readonly currency: string
}

export interface AccountOption {
  readonly id: string
  readonly name: string
  readonly currency: string
}

/** What a "Edit" click on a recent position hands back in, to seed the form. */
export interface EditingPosition {
  readonly transactionId: string
  readonly mode: Mode
  readonly instrumentId: string
  readonly accountId: string
  readonly quantity: string
  /** Unsigned decimal string — total cost/proceeds for a trade, cost for legacy. Empty means unknown (legacy only). */
  readonly amount: string
  readonly description: string
}

/**
 * Buy / sell / legacy in one sheet, same segmented-control shape as the main
 * entry form (PLAN §4.3/§4.4). Buy and sell both settle against — and hold
 * the position in — the same account; a legacy position instead balances
 * against Opening Equity, with cost optional (`COST UNKNOWN`, not zero).
 *
 * `editing`, when set, seeds every field from an existing position and adds
 * a hidden `replacesTransactionId` to whichever form is submitted — the
 * server action voids that transaction and records this one in its place
 * (lib/ledger/instruments.ts), so from here it just looks like an edit.
 *
 * The trade and legacy forms post to different actions and so have to stay two
 * `<form>` elements, but they had been written out twice in full and differed
 * in exactly one field. The shared four are components now; the difference is
 * the `children` each form passes.
 */
export function PositionForm({
  instruments,
  accounts,
  editing,
}: {
  instruments: readonly InstrumentOption[]
  accounts: readonly AccountOption[]
  editing?: EditingPosition
}) {
  const [mode, setMode] = useState<Mode>(editing?.mode ?? 'buy')
  const [instrumentId, setInstrumentId] = useState(editing?.instrumentId ?? instruments[0]?.id ?? '')

  const [tradeState, tradeAction] = useActionState(recordTradeAction, initial)
  const [legacyState, legacyAction] = useActionState(recordLegacyPositionAction, initial)

  // `instrumentId` only gets its initial value at mount, so an instrument
  // added after this component first rendered with an empty list would
  // otherwise leave it stuck on '' forever — a server-action refresh updates
  // `instruments` without remounting this client component. Fall back to the
  // first instrument whenever the stored id no longer matches one currently
  // in the list, rather than trusting raw state directly.
  const selectedId = instruments.some((i) => i.id === instrumentId)
    ? instrumentId
    : (instruments[0]?.id ?? '')
  const instrument = instruments.find((i) => i.id === selectedId)

  if (instruments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add an instrument above before recording a position.
      </p>
    )
  }

  const shared = (
    <>
      <Field>
        <FieldLabel>Instrument</FieldLabel>
        <Select
          name="instrumentId"
          value={selectedId}
          onChange={(e) => setInstrumentId(e.target.value)}
        >
          {instruments.map((i) => (
            <option key={i.id} value={i.id}>
              {i.symbol} ({i.currency})
            </option>
          ))}
        </Select>
      </Field>

      <Field>
        <FieldLabel>Account</FieldLabel>
        <Select
          name="accountId"
          required
          defaultValue={editing?.accountId ?? accounts[0]?.id ?? ''}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.currency}
            </option>
          ))}
        </Select>
      </Field>

      <Field>
        <FieldLabel>Quantity</FieldLabel>
        <Input
          name="quantity"
          required
          inputMode="decimal"
          placeholder="10"
          defaultValue={editing?.quantity}
          className="tabular w-24"
        />
      </Field>
    </>
  )

  const trailing = (
    <>
      <Field className="min-w-40 flex-1">
        <FieldLabel>Note (optional)</FieldLabel>
        <Input name="description" defaultValue={editing?.description} />
      </Field>

      <SubmitButton pendingLabel="Saving…">
        {editing ? 'Save changes' : mode === 'legacy' ? 'Add legacy position' : mode === 'buy' ? 'Record buy' : 'Record sale'}
      </SubmitButton>

      {editing ? (
        <Button asChild variant="ghost" size="sm">
          <Link href="/portfolio">Cancel</Link>
        </Button>
      ) : null}
    </>
  )

  return (
    <div className="flex flex-col gap-4">
      <Segmented options={MODES} value={mode} onChange={setMode} label="Position kind" />

      {mode === 'buy' || mode === 'sell' ? (
        <form action={tradeAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="side" value={mode} />
          {editing ? (
            <input type="hidden" name="replacesTransactionId" value={editing.transactionId} />
          ) : null}
          {shared}
          <Field>
            <FieldLabel>
              {mode === 'buy' ? 'Total cost' : 'Total proceeds'} ({instrument?.currency ?? ''})
            </FieldLabel>
            <Input
              name="amount"
              required
              inputMode="decimal"
              placeholder="1500.00"
              defaultValue={editing?.amount}
              className="tabular w-32"
            />
          </Field>
          {trailing}
          <FormStatus state={tradeState} className="w-full" />
        </form>
      ) : (
        <form action={legacyAction} className="flex flex-wrap items-end gap-3">
          {editing ? (
            <input type="hidden" name="replacesTransactionId" value={editing.transactionId} />
          ) : null}
          <input type="hidden" name="currency" value={instrument?.currency ?? ''} />
          {shared}
          <Field>
            {/*
              Optional on purpose: an unknown cost basis has to stay unknown.
              Defaulting it to zero would render as a 100% gain forever
              (PLAN §7) — hence `COST UNKNOWN` downstream rather than a number.
            */}
            <FieldLabel>Cost (optional)</FieldLabel>
            <Input
              name="cost"
              inputMode="decimal"
              placeholder="Leave blank if unknown"
              defaultValue={editing?.amount}
              className="tabular w-44"
            />
          </Field>
          {trailing}
          <FormStatus state={legacyState} className="w-full" />
        </form>
      )}
    </div>
  )
}
