/**
 * Money — integer minor units + ISO currency code. Never a float.
 *
 * PLAN.md D2. `0.1 + 0.2 !== 0.3`, so every amount in this system is a `bigint`
 * count of minor units (cents/satang) paired with its currency. Floats appear
 * nowhere in this file, including intermediates.
 *
 * Pure: no I/O, no clock, no globals.
 */

export const CURRENCIES = {
  HKD: { minorUnits: 2, symbol: 'HK$', name: 'Hong Kong Dollar' },
  THB: { minorUnits: 2, symbol: '฿', name: 'Thai Baht' },
  USD: { minorUnits: 2, symbol: 'US$', name: 'US Dollar' },
} as const

export type Currency = keyof typeof CURRENCIES

export const BASE_CURRENCY: Currency = 'HKD'

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCIES, value)
}

export function minorUnitsOf(currency: Currency): number {
  return CURRENCIES[currency].minorUnits
}

export interface Money {
  readonly amountMinor: bigint
  readonly currency: Currency
}

/** Rates are stored as NUMERIC(18,8); we carry them as bigint scaled by 10^8. */
export const RATE_SCALE = 8
const RATE_SCALE_FACTOR = 10n ** BigInt(RATE_SCALE)

export interface Rate {
  readonly scaled: bigint
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError'
}

// ── Construction ────────────────────────────────────────────────────────────

export function money(amountMinor: bigint, currency: Currency): Money {
  if (typeof amountMinor !== 'bigint') {
    throw new MoneyError(`amountMinor must be a bigint, got ${typeof amountMinor}`)
  }
  return { amountMinor, currency }
}

export function zero(currency: Currency): Money {
  return { amountMinor: 0n, currency }
}

// ── Rounding ────────────────────────────────────────────────────────────────

/**
 * Divide with banker's rounding (round-half-to-even), on integers only.
 *
 * Half-up would bias every rounded conversion in the same direction, and this
 * system rounds on every multi-currency entry. Half-even is what the plan
 * specifies and what accounting convention expects.
 */
export function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('division by zero')

  const negative = numerator < 0n !== denominator < 0n
  const a = numerator < 0n ? -numerator : numerator
  const b = denominator < 0n ? -denominator : denominator

  let q = a / b
  const remainder = a % b
  const twice = remainder * 2n

  if (twice > b) {
    q += 1n
  } else if (twice === b && q % 2n === 1n) {
    // Exactly half: round to the even neighbour.
    q += 1n
  }

  return negative ? -q : q
}

// ── Arithmetic ──────────────────────────────────────────────────────────────

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `currency mismatch: cannot combine ${a.currency} and ${b.currency}. ` +
        `Convert to a common currency first.`,
    )
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency }
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency }
}

export function negate(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency }
}

export function abs(a: Money): Money {
  return { amountMinor: a.amountMinor < 0n ? -a.amountMinor : a.amountMinor, currency: a.currency }
}

export function sum(items: readonly Money[], currency: Currency): Money {
  let total = 0n
  for (const item of items) {
    if (item.currency !== currency) {
      throw new MoneyError(`currency mismatch in sum: expected ${currency}, got ${item.currency}`)
    }
    total += item.amountMinor
  }
  return { amountMinor: total, currency }
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0n
}

export function isPositive(a: Money): boolean {
  return a.amountMinor > 0n
}

/** -1 if a < b, 0 if equal, 1 if a > b. Throws on currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b)
  if (a.amountMinor < b.amountMinor) return -1
  if (a.amountMinor > b.amountMinor) return 1
  return 0
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor
}

/**
 * Apply a scaled fraction to an amount, half-even. Used for the allocation
 * percentage (PLAN §8) — `percentOf(inflow, parseRate('0.30'))`.
 */
export function applyRate(a: Money, rate: Rate): Money {
  return {
    amountMinor: divRoundHalfEven(a.amountMinor * rate.scaled, RATE_SCALE_FACTOR),
    currency: a.currency,
  }
}

// ── Rates ───────────────────────────────────────────────────────────────────

const RATE_PATTERN = /^-?\d+(\.\d+)?$/

/**
 * Parse a decimal rate string into a scaled bigint. Postgres hands NUMERIC back
 * as a string, so this is the natural boundary — the value never passes through
 * a float, which is the whole point.
 */
export function parseRate(input: string): Rate {
  const trimmed = input.trim()
  if (!RATE_PATTERN.test(trimmed)) {
    throw new MoneyError(`invalid rate: ${JSON.stringify(input)}`)
  }

  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [whole = '0', fraction = ''] = unsigned.split('.')

  // Pad or truncate the fraction to exactly RATE_SCALE digits. Truncation past
  // 8 decimal places matches the NUMERIC(18,8) column and is deliberate.
  const padded = fraction.padEnd(RATE_SCALE, '0').slice(0, RATE_SCALE)
  const scaled = BigInt(whole) * RATE_SCALE_FACTOR + BigInt(padded === '' ? '0' : padded)

  return { scaled: negative ? -scaled : scaled }
}

export function rateToString(rate: Rate): string {
  const negative = rate.scaled < 0n
  const a = negative ? -rate.scaled : rate.scaled
  const whole = a / RATE_SCALE_FACTOR
  const fraction = (a % RATE_SCALE_FACTOR).toString().padStart(RATE_SCALE, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

export const RATE_ONE: Rate = { scaled: RATE_SCALE_FACTOR }

export function isRateOne(rate: Rate): boolean {
  return rate.scaled === RATE_SCALE_FACTOR
}

// ── Conversion ──────────────────────────────────────────────────────────────

/**
 * Convert between currencies at a given rate, half-even.
 *
 * Handles differing minor-unit exponents so that adding a 0-decimal currency
 * later (JPY, KRW) does not silently misprice by 100×. All three current
 * currencies happen to use 2 decimals, which is exactly why this is easy to get
 * wrong and never notice.
 */
export function convert(from: Money, to: Currency, rate: Rate): Money {
  if (from.currency === to && !isRateOne(rate)) {
    throw new MoneyError(
      `refusing to convert ${from.currency} to itself at rate ${rateToString(rate)}`,
    )
  }

  const fromExp = minorUnitsOf(from.currency)
  const toExp = minorUnitsOf(to)

  // amount_to = amount_from * rate * 10^(toExp - fromExp)
  let numerator = from.amountMinor * rate.scaled
  let denominator = RATE_SCALE_FACTOR

  const expDelta = toExp - fromExp
  if (expDelta > 0) numerator *= 10n ** BigInt(expDelta)
  else if (expDelta < 0) denominator *= 10n ** BigInt(-expDelta)

  return { amountMinor: divRoundHalfEven(numerator, denominator), currency: to }
}

/**
 * An amount converted to HKD using a live rate table (currency → HKD rate,
 * as decimal strings — the shape `rateTableFor` returns), or null when
 * there's no rate on record for that currency rather than guessing.
 *
 * Unlike an entry's `amountHkdMinor`, which is frozen at the entry's own
 * event time (PLAN D2), this always uses today's rate — right for a live
 * figure like a holding's current market value, wrong for a historical fact.
 */
export function toHkdMinor(
  amountMinor: bigint,
  currency: Currency,
  rates: Readonly<Record<string, string>>,
): bigint | null {
  if (currency === BASE_CURRENCY) return amountMinor
  const rateText = rates[currency]
  if (rateText === undefined) return null
  return convert(money(amountMinor, currency), BASE_CURRENCY, parseRate(rateText)).amountMinor
}

// ── Parsing and formatting ──────────────────────────────────────────────────

const AMOUNT_PATTERN = /^-?\d*(\.\d*)?$/

/**
 * Parse user keyboard input ("1234.5", "1,234.50", ".5") into minor units.
 *
 * This sits on the hottest path in the product: with import cut (PLAN rev 3),
 * typing is the only way data enters the ledger, so this must accept what a
 * person actually types rather than what a form validator wishes they typed.
 *
 * Rejects more decimal places than the currency has — silently dropping a digit
 * from an amount is exactly the kind of quiet wrongness this codebase is built
 * to avoid.
 */
export function parseAmountInput(input: string, currency: Currency): Money {
  const cleaned = input.trim().replace(/[,_\s]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') {
    throw new MoneyError(`empty amount: ${JSON.stringify(input)}`)
  }
  if (!AMOUNT_PATTERN.test(cleaned)) {
    throw new MoneyError(`invalid amount: ${JSON.stringify(input)}`)
  }

  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  const [whole = '', fraction = ''] = unsigned.split('.')

  const exponent = minorUnitsOf(currency)
  if (fraction.length > exponent) {
    throw new MoneyError(
      `${currency} has ${exponent} decimal places, got ${fraction.length} in ${JSON.stringify(input)}`,
    )
  }

  const scaled =
    BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(exponent) +
    BigInt(fraction === '' ? '0' : fraction.padEnd(exponent, '0'))

  return { amountMinor: negative ? -scaled : scaled, currency }
}

/** Plain decimal string, no separators or symbol. `-1234.50` */
export function toDecimalString(m: Money): string {
  const exponent = minorUnitsOf(m.currency)
  const negative = m.amountMinor < 0n
  const a = negative ? -m.amountMinor : m.amountMinor
  const factor = 10n ** BigInt(exponent)

  const whole = (a / factor).toString()
  if (exponent === 0) return `${negative ? '-' : ''}${whole}`

  const fraction = (a % factor).toString().padStart(exponent, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

/** Display string with grouping and symbol. `HK$1,234.50` */
export function formatMoney(m: Money, opts: { showSymbol?: boolean } = {}): string {
  const { showSymbol = true } = opts
  const decimal = toDecimalString(m)
  const negative = decimal.startsWith('-')
  const unsigned = negative ? decimal.slice(1) : decimal
  const [whole = '0', fraction] = unsigned.split('.')

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = fraction === undefined ? grouped : `${grouped}.${fraction}`
  const symbol = showSymbol ? CURRENCIES[m.currency].symbol : ''

  return `${negative ? '-' : ''}${symbol}${body}`
}

// ── Serialisation ───────────────────────────────────────────────────────────
//
// `bigint` does not survive JSON.stringify, and server→client props in Next.js
// are JSON. These are the only sanctioned crossings.

export interface MoneyJson {
  readonly amountMinor: string
  readonly currency: Currency
}

export function toJson(m: Money): MoneyJson {
  return { amountMinor: m.amountMinor.toString(), currency: m.currency }
}

export function fromJson(json: MoneyJson): Money {
  if (!isCurrency(json.currency)) {
    throw new MoneyError(`unknown currency: ${JSON.stringify(json.currency)}`)
  }
  if (!/^-?\d+$/.test(json.amountMinor)) {
    throw new MoneyError(`invalid amountMinor: ${JSON.stringify(json.amountMinor)}`)
  }
  return { amountMinor: BigInt(json.amountMinor), currency: json.currency }
}
