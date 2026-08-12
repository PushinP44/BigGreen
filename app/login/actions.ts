'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'

export interface LoginState {
  readonly error?: string
  readonly ok?: string
}

const schema = z.object({
  email: z.email('enter a valid email address'),
  next: z.string().max(200).optional(),
})

export async function requestMagicLink(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    next: formData.get('next') ?? undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid email' }
  }

  const origin = (await headers()).get('origin') ?? ''
  // `next` is echoed back into a redirect, so it must be a path on this site.
  // An absolute URL here would turn the sign-in link into an open redirect.
  const next = parsed.data.next?.startsWith('/') ? parsed.data.next : '/'

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  })

  if (error) {
    return { error: error.message }
  }

  // Deliberately the same message whether or not the address has an account:
  // a different response would let anyone check who is registered.
  return { ok: 'Check your email for a sign-in link. It expires in an hour.' }
}
