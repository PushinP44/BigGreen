import { hkd } from '@/lib/domain/balances'
import type { CurrencyPool } from '@/lib/domain/balances'
import type { CardPosition } from '@/lib/domain/credit'
import { formatMoney, money, type Currency } from '@/lib/domain/money'
import type { PoolTerms } from '@/lib/domain/safety'
import { shortDate } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * One currency pool — the headline "safe to spend" figure plus the terms that
 * produced it, because consistency between the number and the numbers under it
 * is what makes the number believable (PLAN §5, §6).
 *
 * Extracted from `app/(app)/page.tsx`, where it was defined below a 160-line
 * data-fetching component and could not be read or changed independently.
 */
export function PoolCard({ pool, worth }: { pool: PoolTerms; worth: CurrencyPool | undefined }) {
  const negative = pool.availableMinor < 0n
  const amount = (minor: bigint) => formatMoney(money(minor, pool.currency))

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-5',
        // The tint is load-bearing, not decoration: a negative pool means you
        // are already past what this currency can cover.
        negative ? 'border-destructive/40 bg-destructive/5' : 'border-primary/40 bg-primary/5',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {pool.currency}
        </span>
        {pool.runwayDays !== null ? (
          <span className="text-xs text-muted-foreground">{Math.floor(pool.runwayDays)}d cover</span>
        ) : null}
      </div>

      <span
        className={cn(
          'tabular text-3xl font-semibold tracking-tight',
          negative && 'text-destructive',
        )}
      >
        {amount(pool.availableMinor)}
      </span>

      <dl className="flex flex-col gap-1 text-xs text-muted-foreground">
        <Term label="Liquid" value={amount(pool.liquidMinor)} />
        {pool.committedMinor > 0n ? (
          <Term label="Committed" value={`− ${amount(pool.committedMinor)}`} />
        ) : null}
        {pool.floorMinor > 0n ? (
          <Term label={`Floor (${pool.floorDays}d)`} value={`− ${amount(pool.floorMinor)}`} />
        ) : (
          <p className="pt-0.5 italic">No floor set — this is a balance, not a cushion.</p>
        )}
        {worth && worth.currency !== 'HKD' ? (
          <Term label="≈ HKD" value={formatMoney(hkd(worth.totalHkdMinor))} />
        ) : null}
      </dl>

      {pool.burnSource !== 'none' ? (
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          burn: {pool.burnSource}
          {pool.burnSource === 'declared' ? ' (not enough history yet)' : ''}
        </span>
      ) : null}

      {pool.cards.map((card) => (
        <CardPanel key={card.accountId} card={card} currency={pool.currency} />
      ))}
    </div>
  )
}

/**
 * The card, split into what it actually is: a payment due soon, and debt.
 *
 * Showing the balance alone hides both halves — you cannot see what is
 * genuinely due next, and you cannot see what carrying the rest costs. The
 * interest figure is the number that makes carrying a balance a visible choice
 * rather than something discovered on a statement.
 */
function CardPanel({ card, currency }: { card: CardPosition; currency: Currency }) {
  const amount = (minor: bigint) => formatMoney(money(minor, currency))
  if (card.owedMinor === 0n) return null

  return (
    <dl className="mt-1 flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted-foreground">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="uppercase tracking-wider">Card owed</dt>
        <dd className="tabular">{amount(card.owedMinor)}</dd>
      </div>
      <Term
        label={`Due ${shortDate(card.cycle.dueAt)}${card.dueWithinHorizon ? '' : ' (past horizon)'}`}
        value={amount(card.minimumPaymentMinor)}
      />
      {card.unbilledMinor > 0n ? (
        <Term label="Since statement" value={amount(card.unbilledMinor)} />
      ) : null}
      {card.estimatedMonthlyInterestMinor !== null && card.estimatedMonthlyInterestMinor > 0n ? (
        <div className="flex items-baseline justify-between gap-3 text-warning">
          <dt>Interest ≈ /month</dt>
          <dd className="tabular">{amount(card.estimatedMonthlyInterestMinor)}</dd>
        </div>
      ) : null}
      {card.availableCreditMinor !== null ? (
        <Term label="Credit left" value={amount(card.availableCreditMinor)} />
      ) : null}
    </dl>
  )
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  )
}
