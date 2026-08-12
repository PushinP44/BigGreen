import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Refresh the Supabase session on every request and gate the app behind it.
 *
 * Server Components cannot write cookies, so a token that expires mid-visit
 * would silently log you out without this. Doing the refresh here means the
 * rest of the app can assume the session it reads is current.
 *
 * The redirect is defence in depth rather than the security boundary — RLS is
 * that, and it holds even if this file is wrong. What this buys is a signed-out
 * visitor seeing a login page instead of an empty dashboard that looks broken.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // No Supabase project configured: the local PGlite path, which has no auth
  // server to talk to.
  if (!url || !anonKey || !process.env.DATABASE_URL) return NextResponse.next()

  let response = NextResponse.next({ request })

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isPublic =
    path.startsWith('/login') ||
    path.startsWith('/auth') ||
    // Signed with HMAC and called by a machine, so it authenticates itself.
    path.startsWith('/api/ingest')

  if (!user && !isPublic) {
    const login = request.nextUrl.clone()
    login.pathname = '/login'
    login.searchParams.set('next', path)
    return NextResponse.redirect(login)
  }

  if (user && path.startsWith('/login')) {
    const home = request.nextUrl.clone()
    home.pathname = '/'
    home.search = ''
    return NextResponse.redirect(home)
  }

  return response
}

export const config = {
  matcher: [
    // Everything except Next's own assets and static files.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
