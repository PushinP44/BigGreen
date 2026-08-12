import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { ensureUserProvisioned } from '@/lib/db/provision'

/**
 * Turn an emailed sign-in link into a session.
 *
 * Supabase has two ways of getting here and which one you get depends on the
 * email template, so both are handled rather than assuming:
 *
 *  - `?code=` — PKCE. What `signInWithOtp` produces when the browser started
 *    the flow and holds the verifier cookie.
 *  - `?token_hash=&type=` — what a template using `{{ .TokenHash }}` produces,
 *    and what admin-generated links produce. No verifier needed.
 *
 * Supporting only the first fails with a bare "missing code" for anyone whose
 * template differs, which is an unpleasant thing to debug from an email.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const nextParam = searchParams.get('next')

  // Only ever redirect to a path on this site — an absolute URL here would be
  // an open redirect reachable from a link in an email.
  const next = nextParam?.startsWith('/') ? nextParam : '/'

  const supabase = await createClient()

  let userId: string | null = null
  let failure = 'missing_code'

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error && data.user) userId = data.user.id
    else failure = 'invalid_link'
  } else if (tokenHash && type) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (!error && data.user) userId = data.user.id
    else failure = 'invalid_link'
  }

  if (!userId) {
    return NextResponse.redirect(`${origin}/login?error=${failure}`)
  }

  try {
    await ensureUserProvisioned(userId)
  } catch (error) {
    // A signed-in user with no system accounts cannot record anything, so
    // failing loudly here beats a dashboard that errors on every action.
    console.error('provisioning failed', error)
    return NextResponse.redirect(`${origin}/login?error=setup_failed`)
  }

  return NextResponse.redirect(`${origin}${next}`)
}
