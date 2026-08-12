import 'server-only'

/**
 * Supabase Auth on the server.
 *
 * Until now the app had no authentication at all: a fixed `APP_USER_ID` stood
 * in, and RLS was driven by a claim the server made up. That was defensible
 * while this was a single-user tool running on one machine. It stops being
 * defensible the moment the app is reachable from the internet, and it is a
 * non-starter for a public one.
 *
 * The identity now comes from a verified session. Everything downstream —
 * `getDb()`, every read model, every write — is scoped to whatever this
 * returns, so a bug here is a tenancy bug and nothing else can save you.
 */

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export interface SessionUser {
  readonly id: string
  readonly email: string | null
}

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    env('NEXT_PUBLIC_SUPABASE_URL'),
    env('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // The middleware refreshes the session, so this is safe to ignore.
          }
        },
      },
    },
  )
}

/**
 * The signed-in user, or null.
 *
 * Uses `getUser()` rather than `getSession()` deliberately: `getSession()`
 * reads the cookie and trusts it, while `getUser()` revalidates the token with
 * Supabase. On a page that decides what money to show you, the difference is
 * whether a forged cookie works.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  if (error || !data.user) return null
  return { id: data.user.id, email: data.user.email ?? null }
}

/**
 * The single-user development identity, used only when there is no Supabase
 * project configured. See `lib/db/seed.ts`.
 */
export const DEV_FALLBACK_USER_ID = '00000000-0000-4000-8000-000000000001'

/**
 * Whether the app is running against a real Supabase project.
 *
 * Local development with the PGlite database has no auth server, so requiring
 * a session there would make the offline path unusable. Anywhere with a real
 * database, a session is mandatory.
 */
export function authRequired(): boolean {
  return Boolean(process.env.DATABASE_URL)
}
