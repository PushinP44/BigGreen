import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge class names, letting later Tailwind utilities win over earlier ones.
 *
 * `clsx` handles the conditional/array/object forms; `twMerge` resolves genuine
 * conflicts, so a caller passing `className="px-6"` to a component whose base
 * is `px-3` gets `px-6` rather than both. Without it the two would both land in
 * the class attribute and the winner would depend on stylesheet order — which
 * is exactly the bug the app has today, where per-call-site overrides are done
 * by interpolating into a shared string (`` `w-24 ${field}` ``) and silently
 * depend on nothing else setting a width.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
