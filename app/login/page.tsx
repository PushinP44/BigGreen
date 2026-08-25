import { LoginForm } from './login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Big Green</h1>
        <p className="text-sm text-muted-foreground">
          Sign in with a link sent to your email. No password to remember, and none for anyone to
          steal.
        </p>
      </header>

      <LoginForm next={next ?? '/'} />
    </main>
  )
}
