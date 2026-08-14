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
 * Same CSS custom properties as the rest of the app rather than hardcoded
 * hex — `var(--color-*)` resolves live, so the chart follows light/dark mode
 * for free. THB is dashed rather than a fourth colour the palette doesn't have.
 */
export function NetWorthChart({ data }: { data: readonly NetWorthPoint[] }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data as NetWorthPoint[]} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
            axisLine={{ stroke: 'var(--color-line)' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
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
          />
          <Line
            type="monotone"
            dataKey="HKD"
            stroke="var(--color-green)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="USD"
            stroke="var(--color-ink)"
            strokeWidth={1.5}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="THB"
            stroke="var(--color-muted)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
