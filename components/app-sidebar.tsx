'use client'

import Link from 'next/link'
import type { Route } from 'next'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  DownloadIcon,
  InboxIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  PieChartIcon,
  SettingsIcon,
  SplitIcon,
  TagsIcon,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn } from '@/lib/utils'

interface NavItem {
  // `Route`, not `string`: next.config.ts enables typedRoutes, so a typo in a
  // path here is a build error rather than a 404 found by clicking.
  readonly href: Route
  readonly label: string
  readonly Icon: LucideIcon
  /** Which count, if any, surfaces as a badge on this item. */
  readonly badge?: 'review' | 'allocations'
}

const NAV: readonly NavItem[] = [
  { href: '/', label: 'Dashboard', Icon: LayoutDashboardIcon },
  { href: '/portfolio', label: 'Portfolio', Icon: PieChartIcon },
  { href: '/accounts', label: 'Accounts', Icon: LandmarkIcon },
  { href: '/categories', label: 'Categories', Icon: TagsIcon },
  { href: '/allocations', label: 'Allocations', Icon: SplitIcon, badge: 'allocations' },
  { href: '/review', label: 'Review', Icon: InboxIcon, badge: 'review' },
  { href: '/settings', label: 'Settings', Icon: SettingsIcon },
]

export interface AppSidebarProps {
  readonly pendingReview: number
  readonly pendingAllocations: number
  readonly email: string | null
}

/**
 * The app shell's navigation.
 *
 * Replaces two things at once: the dashboard's one-off row of nav chips, which
 * existed on exactly one page, and the `← Dashboard` back-link every other page
 * hand-rolled — a 12-line header block duplicated seven times. Being always
 * present also means the review/allocation queues are visible from anywhere
 * rather than only from the dashboard.
 */
export function AppSidebar({ pendingReview, pendingAllocations, email }: AppSidebarProps) {
  // Read once, up here: `nav()` renders inside a `.map`, and a hook called from
  // there would break the rules-of-hooks ordering guarantee.
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const counts = { review: pendingReview, allocations: pendingAllocations }

  const nav = (onNavigate?: () => void) => (
    <nav className="flex flex-1 flex-col gap-0.5" aria-label="Main">
      {NAV.map(({ href, label, Icon, badge }) => {
        // Every path starts with '/', so the dashboard has to match exactly or
        // it would light up on every route. `startsWith` elsewhere is what keeps
        // Settings active on /settings/advanced.
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
        const count = badge ? counts[badge] : 0
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
              active
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{label}</span>
            {count > 0 ? (
              <Badge variant={badge === 'review' ? 'warning' : 'success'}>{count}</Badge>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )

  const footer = (
    <div className="flex flex-col gap-1 border-t border-sidebar-border pt-3">
      <a
        href="/api/export?format=csv"
        className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      >
        <DownloadIcon className="size-4 shrink-0" aria-hidden />
        Export CSV
      </a>
      <form action="/logout" method="post">
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
        >
          <LogOutIcon className="size-4 shrink-0" aria-hidden />
          Sign out
        </button>
      </form>
      <div className="flex items-center justify-between gap-2 pl-2.5 pt-1">
        {email ? (
          <span className="truncate text-xs text-muted-foreground" title={email}>
            {email}
          </span>
        ) : (
          <span />
        )}
        <ThemeToggle />
      </div>
    </div>
  )

  const brand = (
    <Link href="/" className="flex items-baseline gap-2 px-2.5 py-1">
      <span className="text-base font-semibold tracking-tight">Big Green</span>
    </Link>
  )

  return (
    <>
      {/*
        Desktop: always present, no collapse-to-icon — seven items do not need
        one, and a fixed rail keeps the queue badges readable.

        `sticky top-0 h-dvh` rather than letting it stretch: as a flex child it
        would otherwise grow to the *content's* height, so on a long page (the
        dashboard is ~2000px) the nav scrolls off the top and the shell stops
        being a shell. Pinned to the viewport, with its own overflow so a short
        window still reaches Settings.
      */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-sidebar-border bg-sidebar p-3 md:flex">
        {brand}
        {nav()}
        {footer}
      </aside>

      {/* Mobile: a bar with a trigger; the same nav inside a Sheet. */}
      <div className="sticky top-0 z-40 flex items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 py-2 md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            aria-label="Open navigation"
          >
            <MenuIcon className="size-5" />
          </SheetTrigger>
          <SheetContent side="left">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {brand}
            {nav(() => setOpen(false))}
            {footer}
          </SheetContent>
        </Sheet>
        <span className="text-sm font-semibold tracking-tight">Big Green</span>
        <span className="ml-auto flex items-center gap-1">
          {pendingReview > 0 ? <Badge variant="warning">{pendingReview} review</Badge> : null}
          {pendingAllocations > 0 ? (
            <Badge variant="success">{pendingAllocations} allocate</Badge>
          ) : null}
        </span>
      </div>
    </>
  )
}
