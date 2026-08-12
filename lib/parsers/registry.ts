/**
 * Parser registry.
 *
 * One entry per sender, plus the generic fallback. Per-sender parsers go first
 * because they know the layout rather than inferring it, and can therefore be
 * far more confident.
 *
 * The four institutions the owner named — HSBC, KTB, ZA, Mox — are routed here.
 * Only HSBC is known to send per-transaction alerts; earlier research found the
 * other three are push-notification-first. That is fine: mail they do send
 * (statements, notices) simply produces no amount, the generic parser returns
 * null, and nothing reaches the ledger. A source that turns out to email
 * nothing useful costs an unused registry entry, not a wrong balance.
 *
 * Pure: no I/O.
 */

import { genericParser } from './generic'
import type { EmailMessage, ParseResult, Parser } from './types'

/** Institution keys, matching `accounts.institution`. */
export type Institution = 'hsbc' | 'ktb' | 'za' | 'mox'

/**
 * Sender-domain fragments per institution. Matched against the `From` header,
 * lowercased. Kept broad because banks send from many subdomains, and a missed
 * match only means the generic parser handles it anyway.
 */
export const SENDER_HINTS: Readonly<Record<Institution, readonly string[]>> = {
  hsbc: ['hsbc'],
  ktb: ['ktb', 'krungthai'],
  za: ['za.group', 'zabank', 'za.com.hk'],
  mox: ['mox.com', 'moxbank'],
}

export function institutionOf(message: EmailMessage): Institution | null {
  const from = message.from.toLowerCase()
  for (const [institution, hints] of Object.entries(SENDER_HINTS) as Array<
    [Institution, readonly string[]]
  >) {
    if (hints.some((hint) => from.includes(hint))) return institution
  }
  return null
}

/**
 * Per-sender parsers.
 *
 * Empty until real samples exist. Adding one here is how a source moves from
 * "generically parsed, usually needs review" to "trusted enough to post
 * itself" — and PLAN §7.6's rule applies: a parser ships with a redacted
 * fixture or it does not ship, because a bank changing its template should
 * surface as a failing test rather than a wrong balance.
 */
const SENDER_PARSERS: readonly Parser[] = []

const ALL_PARSERS: readonly Parser[] = [...SENDER_PARSERS, genericParser]

export interface RegistryResult extends ParseResult {
  readonly institution: Institution | null
}

/**
 * Parse a message with the most specific parser that applies.
 *
 * Returns null when nothing can read it — the correct outcome for a statement
 * notice or a marketing email, and the reason those never reach the review
 * queue.
 */
export function parseEmail(message: EmailMessage): RegistryResult | null {
  for (const parser of ALL_PARSERS) {
    if (!parser.matches(message)) continue
    const result = parser.parse(message)
    if (result) return { ...result, institution: institutionOf(message) }
  }
  return null
}

export { genericParser }
export type { EmailMessage, ParseResult, Parser }
