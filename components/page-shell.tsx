import Link from 'next/link'
import type { Route } from 'next'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The page container. Replaces `mx-auto flex max-w-3xl flex-col gap-8 px-6
 * py-12`, which was written out on six pages and had already drifted (the
 * portfolio page used `gap-10`).
 *
 * Wider than it was: `max-w-3xl` left the 8-column holdings table cramped
 * enough to scroll on a laptop. Content that genuinely wants to stay narrow
 * can still say so per-page.
 */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className={cn('mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-8 md:px-8 md:py-10', className)}>
      {children}
    </main>
  )
}

/**
 * Page title block. The `← Dashboard` back-link that used to sit above every
 * title is gone: the sidebar makes it redundant, and a back-link that always
 * points home regardless of where you came from was never really "back".
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /**
   * Only for a genuine sub-page — somewhere the sidebar cannot reach directly,
   * which today means `/settings/advanced` alone. Not a substitute for
   * navigation: the old `← Dashboard` on every page pointed home regardless of
   * where you had come from, which is what made it worth deleting.
   */
  back?: { href: Route; label: string }
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        {back ? (
          <Link
            href={back.href}
            className="w-fit text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-primary"
          >
            ← {back.label}
          </Link>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/**
 * A titled block within a page — replaces the `flex flex-col gap-4 border-t
 * border-border pt-8` + `<h2>` pair, whose heading class string alone appeared
 * 22 times across seven files.
 *
 * `divided` is the default because sections read as a stack of related blocks;
 * the first one on a page usually wants it off.
 */
export function Section({
  id,
  title,
  description,
  actions,
  children,
  divided = true,
  className,
}: {
  /** Anchor target — `/portfolio?edit=…#position-form` scrolls to one of these. */
  id?: string
  title?: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  divided?: boolean
  className?: string
}) {
  return (
    <section
      id={id}
      className={cn(
        'flex flex-col gap-4',
        divided && 'border-t border-border pt-8',
        className,
      )}
    >
      {title || actions ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            {title ? <SectionHeading>{title}</SectionHeading> : null}
            {description ? (
              <p className="max-w-2xl text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function SectionHeading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        'text-xs font-medium uppercase tracking-wider text-muted-foreground',
        className,
      )}
    >
      {children}
    </h2>
  )
}
