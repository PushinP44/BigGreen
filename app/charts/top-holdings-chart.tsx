'use client'

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface TopHoldingPoint {
  readonly label: string
  /** Major units, blended to HKD — a chart position, not a figure anything computes from. */
  readonly valueHkd: number
}

/**
 * The 3 largest positions by market value, blended to HKD so a USD position
 * and an HKD position can be ranked against each other — same one-time
 * exception as the allocation breakdown's `computeAllocations` (PLAN rev 4
 * still applies everywhere else: pool cards and the net-worth chart never
 * blend currencies).
 */
export function TopHoldingsChart({ data }: { data: readonly TopHoldingPoint[] }) {
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data as TopHoldingPoint[]} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            axisLine={{ stroke: 'var(--color-line)' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--color-paper)',
              border: '1px solid var(--color-line)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: 'var(--color-ink)' }}
            formatter={(value) => [`HK$${Number(value).toLocaleString()}`, 'Value']}
          />
          <Bar dataKey="valueHkd" fill="var(--color-green)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
