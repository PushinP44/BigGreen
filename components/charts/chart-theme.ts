/**
 * Shared Recharts styling.
 *
 * All four charts had spelled out the same grid stroke, the same two axis tick
 * objects and the same four-property tooltip surface inline — the same class of
 * copy-paste the primitive layer removed from the forms, and the reason the
 * tooltip was still carrying transitional tokens after the pages around it had
 * moved on.
 *
 * These are plain objects rather than components because Recharts reads several
 * of them off the element type at render time; wrapping `<XAxis>` in anything
 * makes it invisible to the parent chart.
 *
 * Values stay CSS `var()` references rather than resolved colours. Recharts
 * writes them into SVG attributes, where a custom property resolves live — so
 * the charts follow the theme without re-rendering. That only works for tokens
 * declared on `:root` itself; a name that exists solely inside `@theme inline`
 * emits nothing, and SVG `fill` would silently fall back to black.
 */

/** Horizontal rules only. Vertical gridlines add noise at these densities. */
export const GRID = {
  stroke: 'var(--border)',
  strokeDasharray: '3 3',
  vertical: false,
} as const

export const AXIS_TICK = { fontSize: 11, fill: 'var(--muted-foreground)' } as const

/** The category axis keeps a baseline; the value axis does not need one. */
export const X_AXIS = {
  tick: AXIS_TICK,
  axisLine: { stroke: 'var(--border)' },
  tickLine: false,
} as const

export const Y_AXIS = {
  tick: AXIS_TICK,
  axisLine: false,
  tickLine: false,
} as const

/**
 * The tooltip is an elevated surface, so it takes `--popover` rather than the
 * page background — otherwise it disappears into whatever sits behind it.
 * `color` is set explicitly because Recharts would otherwise inherit the
 * document's text colour into a panel that is not painted with it.
 */
export const TOOLTIP_CONTENT = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--popover-foreground)',
} as const

export const TOOLTIP_LABEL = { color: 'var(--popover-foreground)' } as const
