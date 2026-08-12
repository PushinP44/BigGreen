'use client'

import { useActionState } from 'react'
import { requestMagicLink, type LoginState } from './actions'

const initial: LoginState = {}

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(requestMagicLink, initial)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-(--color-muted)">Email</span>
        <input
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          placeholder="you@example.com"
          className="rounded-md border border-(--color-line) bg-transparent px-3 py-2.5 text-lg outline-none focus:border-(--color-green)"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-(--color-green) px-5 py-2.5 font-medium text-white transition hover:bg-(--color-green-deep) disabled:opacity-50"
      >
        {pending ? 'Sending…' : 'Send sign-in link'}
      </button>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p className="rounded-md border border-(--color-green)/40 bg-(--color-green)/5 px-4 py-3 text-sm text-(--color-green)">
          {state.ok}
        </p>
      ) : null}
    </form>
  )
}
