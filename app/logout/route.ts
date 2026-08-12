import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Sign out and return to the login page.
 *
 * POST rather than GET: a GET would let any page on the internet sign you out
 * with an <img> tag. Petty, but real.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', request.nextUrl.origin), { status: 303 })
}
