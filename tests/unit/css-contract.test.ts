import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the handful of things in `app/globals.css` that other files depend on
 * by *string*, where breaking the link produces no error anywhere.
 *
 * Every failure mode below ships green: typecheck passes, lint passes, the
 * build succeeds, and all 469 other tests stay green. The app just renders
 * wrong. Since there are no component or E2E tests at all, this file is the
 * only thing standing between a CSS edit and a silent visual regression in a
 * money tracker.
 *
 * Concretely, this has caught-by-construction:
 *   - `shadcn` CLI commands rewriting globals.css and dropping `.tabular` or
 *     the keyframes (the documented reason the CSS is hand-authored).
 *   - A token rename orphaning a `var(--…)` inside a Recharts prop, where an
 *     unresolvable SVG `fill` silently falls back to black.
 */

const CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')

/**
 * The body of one top-level block — i.e. real custom properties, as opposed to
 * `@theme inline`, whose entries are substituted into generated utilities and
 * never emitted as properties a `var()` could resolve.
 *
 * Checked per-block rather than across both: `.dark` only *overrides*, so a
 * token defined solely there would leave light mode broken while still looking
 * "declared" if the two were searched together.
 */
function block(selector: ':root {' | '.dark {'): string {
  const start = CSS.indexOf(selector)
  expect(start, `${selector} block is missing from globals.css`).toBeGreaterThan(-1)
  // Top-level blocks in this file close with `}` at column 0.
  return CSS.slice(start, CSS.indexOf('\n}', start))
}

describe('globals.css — tabular figures', () => {
  it('still defines the tabular utility', () => {
    // 48 call sites across 15 files rely on this class. If it disappears every
    // money column keeps rendering, just with proportional figures whose
    // decimal points no longer line up — invisible to every other check.
    expect(CSS).toMatch(/@utility\s+tabular\s*\{/)
  })

  it('tabular sets both a mono face and tabular-nums', () => {
    const body = CSS.slice(CSS.indexOf('@utility tabular'))
    const rule = body.slice(0, body.indexOf('}'))
    expect(rule).toContain('var(--font-mono)')
    expect(rule).toContain('tabular-nums')
  })

  it('defines the font stack tabular depends on', () => {
    expect(block(':root {')).toMatch(/--font-mono:/)
  })
})

describe('globals.css — smart-alert animation', () => {
  // app/transaction-effects.tsx names these in string literals, so nothing
  // links them. Losing them leaves 24 frozen emoji stuck to the top of the
  // viewport for 2.2 seconds rather than a falling-money effect.
  it.each(['smart-alert-fall', 'smart-alert-flash', 'smart-alert-fade'])(
    'defines @keyframes %s',
    (name) => {
      expect(CSS).toContain(`@keyframes ${name}`)
    },
  )

  it('keeps the reduced-motion override, including its !important', () => {
    // The !important is what lets a stylesheet rule beat the inline `animation`
    // shorthand transaction-effects.tsx sets. Drop it and users who asked for
    // reduced motion get the full falling-and-spinning animation anyway.
    const reducedMotion = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotion).toContain('.smart-alert-dollar')
    expect(reducedMotion).toMatch(/animation-name:\s*smart-alert-fade\s*!important/)
  })
})

describe('globals.css — class-based dark mode', () => {
  it('redefines the dark variant for a class rather than a media query', () => {
    // Tailwind v4's `dark:` variant is media-query based by default. Theming is
    // class-driven now, so without this every `dark:` utility in the app stops
    // matching — silently, with no build error.
    expect(CSS).toMatch(/@custom-variant\s+dark\s*\(&:is\(\.dark \*\)\)/)
  })

  it('drives color-scheme from the theme class, not just the OS', () => {
    // Native <select> popups, checkboxes and scrollbars follow `color-scheme`.
    // If it stayed OS-driven, forcing light while the OS is dark would render
    // every dropdown dark against a light UI.
    expect(block('.dark {')).toMatch(/color-scheme:\s*dark/)
  })
})

describe('globals.css — tokens the charts resolve at runtime', () => {
  // Recharts props land on SVG attributes, so these are resolved by the
  // browser, not the bundler. An unresolvable `fill` falls back to black and an
  // unresolvable `stroke` to none — on a dark background that reads as "the
  // chart is broken", with nothing in any log.
  const chartDir = join(process.cwd(), 'app/charts')
  const chartFiles = readdirSync(chartDir).filter((name) => name.endsWith('.tsx'))

  it('finds the chart files it is meant to be guarding', () => {
    expect(chartFiles.length).toBeGreaterThan(0)
  })

  const referenced = new Set<string>()
  for (const file of chartFiles) {
    const src = readFileSync(join(chartDir, file), 'utf8')
    for (const match of src.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
      referenced.add(match[1]!)
    }
  }

  it.each([...referenced].sort())(
    '%s is a real custom property on :root',
    (token) => {
      // Must be on `:root`, not merely in `@theme inline` (never emitted as a
      // property) and not only under `.dark` (which would leave light mode
      // resolving nothing).
      expect(block(':root {')).toContain(`${token}:`)
    },
  )
})
