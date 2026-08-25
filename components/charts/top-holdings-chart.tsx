'use client'

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { GRID, TOOLTIP_CONTENT, TOOLTIP_LABEL, X_AXIS, Y_AXIS } from './chart-theme'

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
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="label"
            {...X_AXIS}
          />
          <YAxis
            {...Y_AXIS}
            width={48}
          />
          <Tooltip
            contentStyle={TOOLTIP_CONTENT}
            labelStyle={TOOLTIP_LABEL}
            formatter={(value) => [`HK$${Number(value).toLocaleString()}`, 'Value']}
          />
          <Bar dataKey="valueHkd" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
