import { formatMoney, money, type Currency } from '@/lib/domain/money'
import type { PricedHolding } from '@/lib/read/holdings'
import { RefreshButton } from '@/components/refresh-button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

/** Trims a fixed-point decimal string's trailing zeros for display: "10.0000000000" → "10". */
export function formatQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity
  return quantity.replace(/0+$/, '').replace(/\.$/, '')
}

/** "12.5" → "12.50%", "-8" → "-8.00%" — sign comes from the number itself, no explicit "+". */
function formatPercent(percent: number): string {
  return `${percent.toFixed(2)}%`
}

function HoldingRow({ holding }: { holding: PricedHolding }) {
  const currency = holding.currency as Currency
  const amount = (minor: bigint) => formatMoney(money(minor, currency))
  const stale = holding.staleDays !== null && holding.staleDays > 7

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        {holding.symbol}
        {stale ? (
          <Badge variant="warning" className="ml-2">
            {holding.staleDays}d old
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground">{holding.accountName}</TableCell>
      <TableCell className="tabular text-right text-muted-foreground">
        {formatQuantity(holding.quantity)}
      </TableCell>
      <TableCell className="tabular text-right">
        {holding.avgCostMinor === null ? (
          <span className="text-muted-foreground">COST UNKNOWN</span>
        ) : (
          amount(holding.avgCostMinor)
        )}
      </TableCell>
      <TableCell className="tabular text-right">
        {holding.costBasisMinor === null ? (
          <span className="text-muted-foreground">COST UNKNOWN</span>
        ) : (
          amount(holding.costBasisMinor)
        )}
      </TableCell>
      <TableCell className="tabular text-right">
        {holding.priceMinor === null ? '—' : amount(holding.priceMinor)}
      </TableCell>
      <TableCell className="tabular text-right">
        {holding.marketValueMinor === null ? '—' : amount(holding.marketValueMinor)}
      </TableCell>
      <TableCell
        className={cn(
          'tabular text-right',
          holding.unrealizedPlMinor !== null &&
            (holding.unrealizedPlMinor >= 0n ? 'text-primary' : 'text-destructive'),
        )}
      >
        {holding.unrealizedPlMinor === null ? (
          '—'
        ) : (
          <>
            {amount(holding.unrealizedPlMinor)}
            {holding.unrealizedPlPercent === null ? null : (
              <span className="ml-1 text-xs opacity-80">
                ({formatPercent(holding.unrealizedPlPercent)})
              </span>
            )}
          </>
        )}
      </TableCell>
    </TableRow>
  )
}

/**
 * Quantity, avg cost, last price, market value and unrealised P/L per
 * instrument *and account* — the same stock held at two different brokers
 * renders as two rows, never blended into one number that hides which
 * account either half is sitting in. Holdings are a derived read model
 * (PLAN §7), never stored directly, so this is the one place their current
 * value actually renders.
 * Shared between the dashboard and `/portfolio`, which both need it: the
 * dashboard for the whole-net-worth picture, `/portfolio` because it is
 * otherwise just instrument config and a trade form with no view of what
 * those trades add up to.
 */
export function HoldingsTable({ holdings }: { holdings: readonly PricedHolding[] }) {
  if (holdings.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">No positions yet.</p>
        <RefreshButton source="prices" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Avg cost</TableHead>
              <TableHead className="text-right">Initial cost</TableHead>
              <TableHead className="text-right">Last price</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead className="text-right">Unrealised P/L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holdings.map((holding) => (
              <HoldingRow key={`${holding.instrumentId}-${holding.accountId}`} holding={holding} />
            ))}
          </TableBody>
        </Table>
        <TableCaption>
          P/L totals exclude <span className="whitespace-nowrap">COST UNKNOWN</span> positions — a
          fabricated gain is worse than an honest blank.
        </TableCaption>
      </div>
      <RefreshButton source="prices" />
    </div>
  )
}
