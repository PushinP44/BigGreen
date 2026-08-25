'use client'

import { useFormStatus } from 'react-dom'
import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'

/**
 * A submit button that knows on its own whether its form is in flight.
 *
 * Every form in the app threaded `pending` down by hand from `useActionState`
 * — 17 call sites, each re-implementing `disabled={pending}` and
 * `{pending ? 'Saving…' : 'Save'}`. `useFormStatus` reads that from the nearest
 * enclosing `<form>` instead, so the state never has to be passed around.
 *
 * The one constraint it adds: this must be rendered *inside* the form it
 * submits, not as a sibling. Every existing call site already is.
 */
export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  )
}
