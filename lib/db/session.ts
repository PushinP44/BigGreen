import 'server-only'

/**
 * The database handle for the current request, scoped to the signed-in user.
 *
 * Every page and action goes through this rather than calling `getDb()` with an
 * id of its own choosing. That is the whole tenancy boundary: if a caller could
 * pass any user id, RLS would be enforcing a claim the caller invented.
 */

import { cache } from 'react'
import { redirect } from 'next/navigation'
import { getDb, type Db } from './client'
import { authRequired, DEV_FALLBACK_USER_ID, getSessionUser } from '@/lib/supabase/server'

export interface SessionDb {
  readonly db: Db
  readonly userId: string
  readonly email: string | null
}

/**
 * Resolve the session and hand back a scoped handle, or send the visitor to
 * sign in.
 *
 * Wrapped in React's `cache()` so it resolves once per request. Since the
 * signed-in shell layout needs the session *and* every page under it does
 * too, an unmemoised version would mean two `supabase.auth.getUser()` round
 * trips on every page load rather than one.
 *
 * The local PGlite database has no auth server, so development falls back to a
 * fixed identity. Anywhere with a real database, a verified session is
 * mandatory — the fallback is gated on `authRequired()` rather than on an
 * environment name, so it cannot be reached by mistake in production.
 */
export const requireSessionDb = cache(async function requireSessionDb(): Promise<SessionDb> {
  if (!authRequired()) {
    return {
      db: await getDb(DEV_FALLBACK_USER_ID),
      userId: DEV_FALLBACK_USER_ID,
      email: null,
    }
  }

  const user = await getSessionUser()
  if (!user) redirect('/login')

  return { db: await getDb(user.id), userId: user.id, email: user.email }
})

/** Same, but for callers that want to handle the signed-out case themselves. */
export const optionalSessionDb = cache(async function optionalSessionDb(): Promise<SessionDb | null> {
  if (!authRequired()) {
    return {
      db: await getDb(DEV_FALLBACK_USER_ID),
      userId: DEV_FALLBACK_USER_ID,
      email: null,
    }
  }

  const user = await getSessionUser()
  if (!user) return null

  return { db: await getDb(user.id), userId: user.id, email: user.email }
})
