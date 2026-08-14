'use client'

import { useEffect, useState } from 'react'
import type { Direction } from '@/lib/ledger/record'

export interface EffectTrigger {
  readonly direction: Direction
  readonly token: number
}

const VISIBLE_MS = 2200
const DOLLAR_COUNT = 24

interface FallingDollar {
  readonly id: number
  readonly left: number
  readonly delayMs: number
  readonly durationMs: number
  readonly size: number
}

function randomDollars(): FallingDollar[] {
  return Array.from({ length: DOLLAR_COUNT }, (_, id) => ({
    id,
    left: Math.random() * 100,
    delayMs: Math.random() * 400,
    durationMs: 1400 + Math.random() * 900,
    size: 16 + Math.random() * 14,
  }))
}

/**
 * A brief, decorative overlay on a successful spend or income — falling
 * dollars for money in, a full-screen red flash for money out — then back to
 * normal on its own. Purely presentational: never intercepts a click
 * (`pointer-events-none`), keyed off the `direction` the server actually
 * recorded (see `ActionState.direction`'s own comment for why that matters).
 *
 * A transfer never triggers either effect — `direction` is only ever set on
 * a spend/income response, and every transfer in this app moves money
 * between your own accounts, which PLAN D1 is explicit is neither.
 */
export function TransactionEffects({ trigger }: { trigger: EffectTrigger | null }) {
  const [active, setActive] = useState<EffectTrigger | null>(null)
  const [dollars, setDollars] = useState<readonly FallingDollar[]>([])
  // Tracked separately from `active`, deliberately: `active` gets reset to
  // null when the auto-hide timer below fires, but the token must not — if
  // "have I already shown this token" were read off `active`, hiding it would
  // make the very next render think the still-unchanged `trigger` prop was
  // new again and immediately re-show it, so the overlay would never
  // actually go away. Verified end to end (fire → visible → auto-hide →
  // stays hidden) against a running dev server before landing this.
  const [lastToken, setLastToken] = useState<number | null>(null)

  // Adjust state during render rather than in an effect
  // (react-hooks/set-state-in-effect) — React's own sanctioned pattern for
  // "reset/retrigger when a prop changes" (see "You Might Not Need an
  // Effect"). Comparing tokens rather than object identity is what makes
  // this idempotent across the extra render React does to apply this update,
  // rather than re-triggering the animation on every re-render.
  if (trigger && trigger.token !== lastToken) {
    setLastToken(trigger.token)
    setActive(trigger)
    setDollars(trigger.direction === 'income' ? randomDollars() : [])
  }

  // The auto-hide timer is a genuine side effect (an external clock), unlike
  // the state sync above — this is exactly the "subscribe to an external
  // system, setState in its callback" shape the lint rule asks for.
  useEffect(() => {
    if (!active) return
    const timeout = setTimeout(() => setActive(null), VISIBLE_MS)
    return () => clearTimeout(timeout)
  }, [active])

  if (!active) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden="true">
      {active.direction === 'income' ? (
        dollars.map((dollar) => (
          <span
            key={dollar.id}
            className="smart-alert-dollar absolute top-0 select-none"
            style={{
              left: `${dollar.left}%`,
              fontSize: `${dollar.size}px`,
              animation: `smart-alert-fall ${dollar.durationMs}ms ease-in ${dollar.delayMs}ms 1 both`,
            }}
          >
            💵
          </span>
        ))
      ) : (
        <div
          className="absolute inset-0 bg-red-600 dark:bg-red-500"
          style={{ animation: 'smart-alert-flash 900ms ease-out 1 both' }}
        />
      )}
    </div>
  )
}
