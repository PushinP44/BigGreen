import type { ActionState } from '@/lib/action-state'
import { cn } from '@/lib/utils'

/**
 * The error/success pair that followed every submit button — the same seven
 * lines repeated in 15 of the app's 16 form components.
 *
 * Fixes a real accessibility gap while collapsing them: errors already carried
 * `role="alert"`, but success messages were bare `<span>`s at all 11 sites, so
 * "Posted.", "Saved." and "Removed —…" were announced to nobody. `role="status"`
 * is the polite counterpart — it waits for a pause rather than interrupting,
 * which is what a confirmation wants.
 */
export function FormStatus({ state, className }: { state: ActionState; className?: string }) {
  if (state.error) {
    return (
      <span role="alert" className={cn('text-xs text-destructive', className)}>
        {state.error}
      </span>
    )
  }
  if (state.ok) {
    return (
      <span role="status" className={cn('text-xs text-primary', className)}>
        {state.ok}
      </span>
    )
  }
  return null
}
