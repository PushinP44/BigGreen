/**
 * Balance engine — pure aggregation over ledger entries.
 *
 * Everything here takes a plain snapshot and returns numbers. No database, no
 * clock, no `new Date()`. That is what lets the dashboard's figures be tested
 * exhaustively without fixtures, and it is why the read models in `lib/read/`
 * fetch rows but never decide what they mean.
 *
 * PLAN §2, §6.
 */

import { type Interval, contains } from './clock'
import { BASE_CURRENCY, minorUnitsOf, type Currency, type Money } from './money'

/** One ledger entry, flattened with the bits of its transaction that matter. */
export interface EntrySnapshot {
  readonly transactionId: string
  readonly accountId: string
  readonly amountMinor: bigint
  readonly currency: Currency
  readonly amountHkdMinor: bigint
  readonly occurredAt: Date
  readonly status: 'scheduled' | 'pending' | 'posted' | 'void'
  readonly categoryId: string | null
  readonly isFxResidual: boolean
}

export interface AccountSnapshot {
  readonly id: string
  readonly kind: string
  readonly currency: Currency
  readonly isLiquid: boolean
  readonly isOwn: boolean
  readonly openingBalanceMinor: bigint
  /** Set only on credit cards; absent means the simple model (PLAN §5). */
  readonly card?: CardTermsSnapshot | undefined
}

export interface CardTermsSnapshot {
  readonly statementDay: number | null
  readonly paymentDueDay: number | null
  readonly creditLimitMinor: bigint | null
  readonly aprBps: number | null
  readonly minPaymentPctBps: number | null
  readonly minPaymentFloorMinor: bigint | null
}

export interface CategorySnapshot {
  readonly id: string
  readonly name: string
  readonly isDiscretionary: boolean
}

/**
 * Only `posted` entries count toward money you actually have.
 *
 * `scheduled` is a future commitment (it feeds the safety rule's `committed`
 * term, not your balance) and `pending` is unconfirmed. Letting either leak
 * into a balance is how a tracker starts disagreeing with your bank.
 */
function counts(entry: EntrySnapshot): boolean {
  return entry.status === 'posted'
}

// ── Balances ────────────────────────────────────────────────────────────────

export interface AccountBalanceResult {
  readonly accountId: string
  /** In the account's own currency, counting only entries denominated in it. */
  readonly nativeMinor: bigint
  readonly hkdMinor: bigint
  /**
   * Entries in some other currency. Non-zero means `nativeMinor` is a partial
   * figure and only `hkdMinor` tells the whole story — true of the shared
   * system accounts, which receive entries in every currency.
   */
  readonly foreignEntryCount: number
}

export function accountBalances(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
): Map<string, AccountBalanceResult> {
  const result = new Map<string, AccountBalanceResult>()

  for (const account of accounts) {
    result.set(account.id, {
      accountId: account.id,
      nativeMinor: account.openingBalanceMinor,
      hkdMinor: 0n,
      foreignEntryCount: 0,
    })
  }

  const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]))

  for (const entry of entries) {
    if (!counts(entry)) continue

    const current = result.get(entry.accountId)
    if (current === undefined) continue // entry against an unknown account

    const sameCurrency = currencyOf.get(entry.accountId) === entry.currency

    result.set(entry.accountId, {
      accountId: entry.accountId,
      nativeMinor: sameCurrency ? current.nativeMinor + entry.amountMinor : current.nativeMinor,
      hkdMinor: current.hkdMinor + entry.amountHkdMinor,
      foreignEntryCount: current.foreignEntryCount + (sameCurrency ? 0 : 1),
    })
  }

  return result
}

/** Σ balances of accounts that are both liquid and owned — the safety rule's `liquid`. */
export function liquidHkdMinor(
  accounts: readonly AccountSnapshot[],
  balances: Map<string, AccountBalanceResult>,
): bigint {
  let total = 0n
  for (const account of accounts) {
    if (!account.isLiquid || !account.isOwn) continue
    total += balances.get(account.id)?.hkdMinor ?? 0n
  }
  return total
}

// ── Currency pools ──────────────────────────────────────────────────────────

/**
 * A pool is all the money you hold in one currency.
 *
 * PLAN rev 4. HKD is the unit the ledger *balances* in, but it is not the unit
 * anything is *reported* in, because THB sitting in a Thai bank cannot buy
 * lunch in Hong Kong. Summing the three into one figure states that money is
 * available today when it is days and a conversion spread away — the same
 * failure the credit-card treatment in §5 exists to avoid.
 *
 * Every figure here is in the pool's own minor units.
 */
export interface CurrencyPool {
  readonly currency: Currency
  readonly liquidMinor: bigint
  readonly investmentsMinor: bigint
  readonly liabilitiesMinor: bigint
  readonly totalMinor: bigint
  /** The same total in HKD at each entry's frozen rate — an estimate, never the headline. */
  readonly totalHkdMinor: bigint
  readonly accountIds: readonly string[]
}

export function currencyPools(
  accounts: readonly AccountSnapshot[],
  balances: Map<string, AccountBalanceResult>,
): CurrencyPool[] {
  const pools = new Map<Currency, {
    liquid: bigint
    investments: bigint
    liabilities: bigint
    hkd: bigint
    ids: string[]
  }>()

  for (const account of accounts) {
    if (!account.isOwn) continue

    const balance = balances.get(account.id)
    const native = balance?.nativeMinor ?? 0n
    const hkd = balance?.hkdMinor ?? 0n

    const pool = pools.get(account.currency) ?? {
      liquid: 0n,
      investments: 0n,
      liabilities: 0n,
      hkd: 0n,
      ids: [],
    }

    if (account.kind === 'credit_card') pool.liabilities += native
    else if (account.kind === 'brokerage') pool.investments += native
    else if (account.isLiquid) pool.liquid += native
    // A non-liquid, non-card, non-brokerage owned account (a fixed deposit,
    // say) counts toward the total but never toward spendable liquidity.

    pool.hkd += hkd
    pool.ids.push(account.id)
    pools.set(account.currency, pool)
  }

  return [...pools.entries()]
    .map(([currency, pool]) => ({
      currency,
      liquidMinor: pool.liquid,
      investmentsMinor: pool.investments,
      liabilitiesMinor: pool.liabilities,
      totalMinor: pool.liquid + pool.investments + pool.liabilities,
      totalHkdMinor: pool.hkd,
      accountIds: pool.ids,
    }))
    // Base currency first: it is where you live, so it is what you look at.
    .sort((a, b) =>
      a.currency === BASE_CURRENCY ? -1 : b.currency === BASE_CURRENCY ? 1 : a.currency.localeCompare(b.currency),
    )
}

export function findPool(
  pools: readonly CurrencyPool[],
  currency: Currency,
): CurrencyPool | undefined {
  return pools.find((pool) => pool.currency === currency)
}

/**
 * Everything you own minus everything you owe.
 *
 * Credit cards carry a negative balance already (spending on a card credits the
 * liability), so this is a plain sum over owned accounts rather than a
 * subtraction — the sign is carried by the ledger, not applied here.
 */
export interface NetWorth {
  readonly liquidHkdMinor: bigint
  readonly investmentsHkdMinor: bigint
  readonly liabilitiesHkdMinor: bigint
  readonly totalHkdMinor: bigint
  /**
   * False until P4 lands holdings. The dashboard must say so rather than
   * present a partial figure as the whole (PLAN §6.2) — a net worth that
   * quietly omits your portfolio is worse than one that admits the gap.
   */
  readonly includesInvestments: boolean
}

export function netWorth(
  accounts: readonly AccountSnapshot[],
  balances: Map<string, AccountBalanceResult>,
  opts: { includesInvestments?: boolean } = {},
): NetWorth {
  let liquid = 0n
  let investments = 0n
  let liabilities = 0n

  for (const account of accounts) {
    if (!account.isOwn) continue
    const hkd = balances.get(account.id)?.hkdMinor ?? 0n

    if (account.kind === 'credit_card') liabilities += hkd
    else if (account.kind === 'brokerage') investments += hkd
    else liquid += hkd
  }

  return {
    liquidHkdMinor: liquid,
    investmentsHkdMinor: investments,
    liabilitiesHkdMinor: liabilities,
    totalHkdMinor: liquid + investments + liabilities,
    includesInvestments: opts.includesInvestments ?? false,
  }
}

// ── Spending ────────────────────────────────────────────────────────────────

/**
 * How much a whole transaction moved across the boundary of your balance sheet.
 *
 * Spending is not a property of an entry — it is a property of a transaction.
 * Summing negative entries would count a bank→broker transfer as spending;
 * netting all entries would let a month's income cancel a month's spending.
 * Both are wrong, and both are only visible once you group.
 *
 * Negative means money left your accounts, positive means it arrived, and zero
 * means it only moved between accounts you own — which falls out of the
 * arithmetic rather than needing a special case. That is the entire reason this
 * app is double-entry (PLAN D1), and it is the same test the allocation rule
 * uses to tell new money from your own money moving around (PLAN §8).
 */
export interface TransactionDelta {
  readonly transactionId: string
  readonly ownedDeltaHkdMinor: bigint
  readonly occurredAt: Date
  readonly categoryId: string | null
}

export function transactionDeltas(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
): TransactionDelta[] {
  const owned = new Set(accounts.filter((a) => a.isOwn).map((a) => a.id))
  const byTransaction = new Map<string, TransactionDelta>()

  for (const entry of entries) {
    if (!counts(entry)) continue

    const current = byTransaction.get(entry.transactionId)
    const contribution = owned.has(entry.accountId) ? entry.amountHkdMinor : 0n

    byTransaction.set(entry.transactionId, {
      transactionId: entry.transactionId,
      ownedDeltaHkdMinor: (current?.ownedDeltaHkdMinor ?? 0n) + contribution,
      occurredAt: current?.occurredAt ?? entry.occurredAt,
      categoryId: current?.categoryId ?? entry.categoryId,
    })
  }

  return [...byTransaction.values()]
}

/** Money that left your accounts to the outside world, as a positive number. */
export function spentInInterval(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  interval: Interval,
): bigint {
  let total = 0n
  for (const delta of transactionDeltas(accounts, entries)) {
    if (!contains(interval, delta.occurredAt)) continue
    if (delta.ownedDeltaHkdMinor < 0n) total += -delta.ownedDeltaHkdMinor
  }
  return total
}

export function incomeInInterval(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  interval: Interval,
): bigint {
  let total = 0n
  for (const delta of transactionDeltas(accounts, entries)) {
    if (!contains(interval, delta.occurredAt)) continue
    if (delta.ownedDeltaHkdMinor > 0n) total += delta.ownedDeltaHkdMinor
  }
  return total
}

/**
 * Discretionary spend in the interval — the `discretionary_spent_mtd` term of
 * the safety rule (PLAN §5).
 */
export function discretionarySpentInInterval(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  categories: readonly CategorySnapshot[],
  interval: Interval,
): bigint {
  const discretionary = new Set(categories.filter((c) => c.isDiscretionary).map((c) => c.id))

  let total = 0n
  for (const delta of transactionDeltas(accounts, entries)) {
    if (!contains(interval, delta.occurredAt)) continue
    if (delta.categoryId === null || !discretionary.has(delta.categoryId)) continue
    if (delta.ownedDeltaHkdMinor < 0n) total += -delta.ownedDeltaHkdMinor
  }
  return total
}

export interface CategoryTotal {
  readonly categoryId: string | null
  readonly name: string
  readonly hkdMinor: bigint
}

/** Spending by category for a period — the dashboard's category chart. */
export function spendByCategory(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  categories: readonly CategorySnapshot[],
  interval: Interval,
): CategoryTotal[] {
  const nameOf = new Map(categories.map((c) => [c.id, c.name]))
  const totals = new Map<string | null, bigint>()

  for (const delta of transactionDeltas(accounts, entries)) {
    if (!contains(interval, delta.occurredAt)) continue
    if (delta.ownedDeltaHkdMinor >= 0n) continue

    const key = delta.categoryId
    totals.set(key, (totals.get(key) ?? 0n) + -delta.ownedDeltaHkdMinor)
  }

  return [...totals.entries()]
    .map(([categoryId, hkdMinor]) => ({
      categoryId,
      name: categoryId === null ? 'Uncategorised' : (nameOf.get(categoryId) ?? 'Unknown'),
      hkdMinor,
    }))
    .sort((a, b) => (b.hkdMinor > a.hkdMinor ? 1 : b.hkdMinor < a.hkdMinor ? -1 : 0))
}

/**
 * Every entry in a balanced ledger sums to zero. If this ever returns false the
 * database's deferred trigger has been bypassed, and no figure above can be
 * trusted — so the dashboard checks it rather than assuming it.
 */
export function ledgerIsBalanced(entries: readonly EntrySnapshot[]): boolean {
  let total = 0n
  for (const entry of entries) {
    if (entry.status === 'void') continue
    total += entry.amountHkdMinor
  }
  return total === 0n
}

export function hkd(amountMinor: bigint): Money {
  return { amountMinor, currency: BASE_CURRENCY }
}

/**
 * Spending in one currency over an interval, in that currency's own units.
 *
 * Used to measure a pool's burn rate. Unlike `spentInInterval` this does not
 * convert — a THB burn rate belongs in baht, because the floor it produces is
 * compared against a baht balance.
 */
export function spentInCurrency(
  accounts: readonly AccountSnapshot[],
  entries: readonly EntrySnapshot[],
  currency: Currency,
  interval: Interval,
): bigint {
  const owned = new Set(accounts.filter((a) => a.isOwn).map((a) => a.id))
  const byTransaction = new Map<string, { delta: bigint; occurredAt: Date }>()

  for (const entry of entries) {
    if (!counts(entry)) continue
    if (entry.currency !== currency) continue

    const contribution = owned.has(entry.accountId) ? entry.amountMinor : 0n
    const current = byTransaction.get(entry.transactionId)
    byTransaction.set(entry.transactionId, {
      delta: (current?.delta ?? 0n) + contribution,
      occurredAt: current?.occurredAt ?? entry.occurredAt,
    })
  }

  let total = 0n
  for (const { delta, occurredAt } of byTransaction.values()) {
    if (!contains(interval, occurredAt)) continue
    if (delta < 0n) total += -delta
  }
  return total
}

/** Minor units per major unit, e.g. 100 for a 2-decimal currency. */
export function minorFactor(currency: Currency): bigint {
  return 10n ** BigInt(minorUnitsOf(currency))
}
