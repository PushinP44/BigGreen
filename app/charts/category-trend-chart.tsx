'use client'

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

/** Same lightness/chroma family as the theme's green, hue rotated — see globals.css. */
const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--muted-foreground)', // "Other" always renders in this slot — see the page that builds categoryKeys
]

export interface CategoryTrendRow {
  label: string
  [categoryName: string]: string | number
}

/**
 * Stacked bar per period, one colour per category — reuses branch 2's
 * `spendByCategorySeries` data directly rather than a second aggregation.
 * Capped at a handful of named categories plus "Other" by the caller
 * (rendering every category as its own stack segment stops being readable
 * past five or six), so `categoryKeys` is authoritative over what's plotted.
 */
export function CategoryTrendChart({
  data,
  categoryKeys,
}: {
  data: readonly CategoryTrendRow[]
  categoryKeys: readonly string[]
}) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data as CategoryTrendRow[]}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        >
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
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {categoryKeys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="spend"
              fill={PALETTE[index % PALETTE.length]}
              radius={index === categoryKeys.length - 1 ? [3, 3, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
