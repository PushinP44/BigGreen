'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export interface MoverPoint {
  readonly label: string
  /** Unrealised P/L percent — same display-only ratio as `percentChange`, never summed or stored. */
  readonly percent: number
}

/**
 * The 3 biggest gainers and the 3 biggest losers by unrealised P/L percent —
 * percent rather than dollar amount, since a tiny position swinging 40% is a
 * bigger story than a large one moving 2%, and percent needs no HKD
 * conversion to compare positions priced in different currencies.
 */
export function TopMoversChart({ data }: { data: readonly MoverPoint[] }) {
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data as MoverPoint[]} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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
            tickFormatter={(value: number) => `${value}%`}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--color-paper)',
              border: '1px solid var(--color-line)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: 'var(--color-ink)' }}
            formatter={(value) => [`${Number(value).toFixed(2)}%`, 'Unrealised P/L']}
          />
          <ReferenceLine y={0} stroke="var(--color-line)" />
          <Bar dataKey="percent" radius={[3, 3, 3, 3]}>
            {data.map((point) => (
              <Cell
                key={point.label}
                fill={point.percent >= 0 ? 'var(--color-green)' : 'var(--color-loss)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
