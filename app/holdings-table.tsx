import { formatMoney, money, type Currency } from '@/lib/domain/money'
import type { PricedHolding } from '@/lib/read/holdings'
import { RefreshPrices } from './refresh-prices'

/** Trims a fixed-point decimal string's trailing zeros for display: "10.0000000000" → "10". */
function formatQuantity(quantity: string): string {
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
    <tr className="border-b border-(--color-line)/60">
      <td className="py-2 pr-4">
        {holding.symbol}
        {stale ? (
          <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
            {holding.staleDays}d old
          </span>
        ) : null}
      </td>
      <td className="tabular py-2 pr-4 text-right text-(--color-muted)">
        {formatQuantity(holding.quantity)}
      </td>
      <td className="tabular py-2 pr-4 text-right">
        {holding.avgCostMinor === null ? (
          <span className="text-(--color-muted)">COST UNKNOWN</span>
        ) : (
          amount(holding.avgCostMinor)
        )}
      </td>
      <td className="tabular py-2 pr-4 text-right">
        {holding.costBasisMinor === null ? (
          <span className="text-(--color-muted)">COST UNKNOWN</span>
        ) : (
          amount(holding.costBasisMinor)
        )}
      </td>
      <td className="tabular py-2 pr-4 text-right">
        {holding.priceMinor === null ? '—' : amount(holding.priceMinor)}
      </td>
      <td className="tabular py-2 pr-4 text-right">
        {holding.marketValueMinor === null ? '—' : amount(holding.marketValueMinor)}
      </td>
      <td
        className={`tabular py-2 text-right ${
          holding.unrealizedPlMinor === null
            ? ''
            : holding.unrealizedPlMinor >= 0n
              ? 'text-(--color-green)'
              : 'text-red-600 dark:text-red-400'
        }`}
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
      </td>
    </tr>
  )
}

/**
 * Quantity, avg cost, last price, market value and unrealised P/L per
 * instrument — holdings are a derived read model (PLAN §7), never stored
 * directly, so this is the one place their current value actually renders.
 * Shared between the dashboard and `/portfolio`, which both need it: the
 * dashboard for the whole-net-worth picture, `/portfolio` because it is
 * otherwise just instrument config and a trade form with no view of what
 * those trades add up to.
 */
export function HoldingsTable({ holdings }: { holdings: readonly PricedHolding[] }) {
  if (holdings.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-(--color-muted)">No positions yet.</p>
        <RefreshPrices />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-(--color-line) text-left text-xs uppercase tracking-wide text-(--color-muted)">
              <th className="py-2 pr-4 font-medium">Symbol</th>
              <th className="py-2 pr-4 text-right font-medium">Quantity</th>
              <th className="py-2 pr-4 text-right font-medium">Avg cost</th>
              <th className="py-2 pr-4 text-right font-medium">Initial cost</th>
              <th className="py-2 pr-4 text-right font-medium">Last price</th>
              <th className="py-2 pr-4 text-right font-medium">Value</th>
              <th className="py-2 text-right font-medium">Unrealised P/L</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((holding) => (
              <HoldingRow key={holding.instrumentId} holding={holding} />
            ))}
          </tbody>
        </table>
        <p className="pt-2 text-xs text-(--color-muted)">
          P/L totals exclude <span className="whitespace-nowrap">COST UNKNOWN</span> positions — a
          fabricated gain is worse than an honest blank.
        </p>
      </div>
      <RefreshPrices />
    </div>
  )
}
