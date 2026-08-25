'use client'

import { useTheme } from 'next-themes'
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const OPTIONS = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
] as const

/**
 * Three explicit choices rather than a two-way toggle: "system" is a distinct
 * state from whichever side the OS currently happens to be on, and collapsing
 * it away is what makes a toggle feel broken when the OS flips at sunset.
 *
 * The trigger renders **both** icons and lets CSS choose between them via the
 * `dark:` variant. The obvious alternative — reading the resolved theme and
 * rendering one icon — cannot work during SSR, since the answer lives in
 * localStorage and the OS; the usual fix is a `mounted` flag set from an
 * effect, which this repo's lint rules reject (`react-hooks/set-state-in-effect`)
 * and which costs an extra render plus a visible placeholder icon on every
 * load. CSS knows the answer before React does.
 *
 * The menu itself is safe to drive from `theme` because Radix only mounts the
 * portalled content once it is open, which is necessarily after hydration.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Change theme">
          <SunIcon
            className="size-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0"
            aria-hidden
          />
          <MoonIcon
            className="absolute size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100"
            aria-hidden
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
          {OPTIONS.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
