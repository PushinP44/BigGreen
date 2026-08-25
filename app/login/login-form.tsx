'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/submit-button'
import { requestMagicLink, type LoginState } from './actions'

const initial: LoginState = {}

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(requestMagicLink, initial)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      <Field>
        <FieldLabel>Email</FieldLabel>
        <Input
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          placeholder="you@example.com"
          // The one oversized input in the app: it is the only thing on the
          // page, and this is the single field standing between you and your
          // own money.
          className="h-11 text-base md:text-base"
        />
      </Field>

      <SubmitButton size="lg" pendingLabel="Sending…">
        Send sign-in link
      </SubmitButton>

      {/*
        Not <FormStatus>: on this page the outcome is the entire result of the
        interaction rather than a footnote beside a button, so it gets a block
        with room to breathe. `Alert` supplies the role — assertive for the
        failure, polite for the confirmation.
      */}
      {state.error ? <Alert variant="destructive">{state.error}</Alert> : null}
      {state.ok ? <Alert variant="success">{state.ok}</Alert> : null}
    </form>
  )
}
