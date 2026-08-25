'use client'

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { GRID, TOOLTIP_CONTENT, TOOLTIP_LABEL, X_AXIS, Y_AXIS } from './chart-theme'

export interface NetWorthPoint {
  readonly label: string
  readonly HKD: number
  readonly USD: number
  readonly THB: number
}

/**
 * One line per currency pool — never blended, matching the pool cards above
 * it (PLAN rev 4). Values cross the server→client boundary as plain numbers
 * in major units: a chart position, not a figure anything computes from, so
 * this is the one place a `bigint` is allowed to become a JS `number`.
 *
 * Colours come from the shared chart tokens rather than hardcoded hex, so the
 * lines follow light/dark mode without re-rendering — see ./chart-theme.
 * HKD keeps `--chart-1` because it is the base currency and that slot is the
 * app's green. THB stays dashed even though it now has a hue of its own:
 * three lines at 1.5px are easier to tell apart when shape carries some of the
 * distinction too, and it means the chart still reads without colour.
 */
export function NetWorthChart({ data }: { data: readonly NetWorthPoint[] }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data as NetWorthPoint[]} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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
          />
          <Line
            type="monotone"
            dataKey="HKD"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="USD"
            stroke="var(--chart-3)"
            strokeWidth={1.5}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="THB"
            stroke="var(--chart-2)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
