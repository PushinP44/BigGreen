import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  add,
  applyRate,
  compare,
  convert,
  divRoundHalfEven,
  equals,
  formatMoney,
  fromJson,
  isCurrency,
  money,
  MoneyError,
  negate,
  parseAmountInput,
  parseRate,
  RATE_ONE,
  rateToString,
  subtract,
  sum,
  toDecimalString,
  toHkdMinor,
  toJson,
  zero,
  type Currency,
} from '@/lib/domain/money'

const anyMinor = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n })
const anyCurrency = fc.constantFrom<Currency>('HKD', 'THB', 'USD')

describe('divRoundHalfEven', () => {
  it.each([
    [5n, 2n, 2n], // 2.5 → 2 (even)
    [7n, 2n, 4n], // 3.5 → 4 (even)
    [1n, 2n, 0n], // 0.5 → 0 (even)
    [3n, 2n, 2n], // 1.5 → 2 (even)
    [4n, 2n, 2n], // exact
    [1n, 3n, 0n], // 0.333 → 0
    [2n, 3n, 1n], // 0.667 → 1
    [-5n, 2n, -2n], // symmetric
    [-7n, 2n, -4n],
  ])('divRoundHalfEven(%s, %s) === %s', (num, den, expected) => {
    expect(divRoundHalfEven(num, den)).toBe(expected)
  })

  it('throws on division by zero', () => {
    expect(() => divRoundHalfEven(1n, 0n)).toThrow(MoneyError)
  })

  it('always lands on a nearest integer', () => {
    fc.assert(
      fc.property(anyMinor, fc.bigInt({ min: 1n, max: 10n ** 9n }), (num, den) => {
        const q = divRoundHalfEven(num, den)
        const error = q * den - num
        const magnitude = error < 0n ? -error : error
        // |q - num/den| <= 1/2  ⟺  2|q·den − num| <= den
        expect(magnitude * 2n <= den).toBe(true)
      }),
    )
  })

  it('is symmetric under negation (no bias toward positive or negative)', () => {
    fc.assert(
      fc.property(anyMinor, fc.bigInt({ min: 1n, max: 10n ** 9n }), (num, den) => {
        expect(divRoundHalfEven(-num, den)).toBe(-divRoundHalfEven(num, den))
      }),
    )
  })

  it('rounds exact halves to an even quotient', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 6n }), (k) => {
        // (2k+1)/2 is always exactly half
        expect(divRoundHalfEven(2n * k + 1n, 2n) % 2n).toBe(0n)
      }),
    )
  })
})

describe('arithmetic', () => {
  it('adds and subtracts within a currency', () => {
    const a = money(1000n, 'HKD')
    const b = money(250n, 'HKD')
    expect(add(a, b).amountMinor).toBe(1250n)
    expect(subtract(a, b).amountMinor).toBe(750n)
  })

  it('refuses to combine different currencies', () => {
    expect(() => add(money(1n, 'HKD'), money(1n, 'USD'))).toThrow(/currency mismatch/)
    expect(() => subtract(money(1n, 'THB'), money(1n, 'HKD'))).toThrow(/currency mismatch/)
    expect(() => compare(money(1n, 'THB'), money(1n, 'USD'))).toThrow(/currency mismatch/)
    expect(() => sum([money(1n, 'THB')], 'HKD')).toThrow(/currency mismatch/)
  })

  it('add is associative and commutative', () => {
    fc.assert(
      fc.property(anyMinor, anyMinor, anyMinor, (x, y, z) => {
        const a = money(x, 'HKD')
        const b = money(y, 'HKD')
        const c = money(z, 'HKD')
        expect(equals(add(add(a, b), c), add(a, add(b, c)))).toBe(true)
        expect(equals(add(a, b), add(b, a))).toBe(true)
      }),
    )
  })

  it('zero is the additive identity and negate is its inverse', () => {
    fc.assert(
      fc.property(anyMinor, anyCurrency, (x, currency) => {
        const a = money(x, currency)
        expect(equals(add(a, zero(currency)), a)).toBe(true)
        expect(equals(add(a, negate(a)), zero(currency))).toBe(true)
      }),
    )
  })

  it('sums an empty list to zero', () => {
    expect(equals(sum([], 'HKD'), zero('HKD'))).toBe(true)
  })

  it('orders with compare', () => {
    expect(compare(money(1n, 'HKD'), money(2n, 'HKD'))).toBe(-1)
    expect(compare(money(2n, 'HKD'), money(1n, 'HKD'))).toBe(1)
    expect(compare(money(2n, 'HKD'), money(2n, 'HKD'))).toBe(0)
  })

  it('rejects a non-bigint amount at the constructor', () => {
    // The whole point of the type is defeated if a float sneaks in at runtime,
    // e.g. from JSON that skipped `fromJson`.
    expect(() => money(12.5 as unknown as bigint, 'HKD')).toThrow(MoneyError)
  })
})

describe('rates', () => {
  it('parses and reprints decimal strings losslessly', () => {
    expect(rateToString(parseRate('7.8'))).toBe('7.80000000')
    expect(rateToString(parseRate('1'))).toBe('1.00000000')
    expect(rateToString(parseRate('0.22415000'))).toBe('0.22415000')
    expect(rateToString(parseRate('-2.5'))).toBe('-2.50000000')
  })

  it('truncates beyond the NUMERIC(18,8) scale rather than rounding into it', () => {
    expect(rateToString(parseRate('1.123456789'))).toBe('1.12345678')
  })

  it('rejects malformed rates', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', '--1', '1,5']) {
      expect(() => parseRate(bad), bad).toThrow(MoneyError)
    }
  })

  it('applies a rate with half-even rounding', () => {
    // 30% of 2000.01 HKD = 600.003 → 600.00
    expect(applyRate(money(200001n, 'HKD'), parseRate('0.30')).amountMinor).toBe(60000n)
    // 30% of 2000.05 HKD = 600.015 → 600.02 (0.5 rounds to even 2)
    expect(applyRate(money(200005n, 'HKD'), parseRate('0.30')).amountMinor).toBe(60002n)
  })
})

describe('convert', () => {
  it('converts USD to HKD at the given rate', () => {
    // 100.00 USD @ 7.8 = 780.00 HKD
    expect(convert(money(10000n, 'USD'), 'HKD', parseRate('7.8')).amountMinor).toBe(78000n)
  })

  it('converts THB to HKD', () => {
    // 1000.00 THB @ 0.2242 = 224.20 HKD
    expect(convert(money(100000n, 'THB'), 'HKD', parseRate('0.2242')).amountMinor).toBe(22420n)
  })

  it('is identity at rate 1 for the same currency', () => {
    fc.assert(
      fc.property(anyMinor, anyCurrency, (x, currency) => {
        expect(convert(money(x, currency), currency, RATE_ONE).amountMinor).toBe(x)
      }),
    )
  })

  it('refuses a self-conversion at a rate other than 1', () => {
    // This would silently multiply an amount by 7.8 and leave the currency
    // unchanged, which is the worst possible failure mode here.
    expect(() => convert(money(100n, 'HKD'), 'HKD', parseRate('7.8'))).toThrow(
      /convert HKD to itself/,
    )
  })

  it('commutes with negation', () => {
    fc.assert(
      fc.property(anyMinor, (x) => {
        const rate = parseRate('7.83251')
        const a = convert(money(-x, 'USD'), 'HKD', rate).amountMinor
        const b = -convert(money(x, 'USD'), 'HKD', rate).amountMinor
        expect(a).toBe(b)
      }),
    )
  })

  it('maps zero to zero', () => {
    expect(convert(money(0n, 'THB'), 'HKD', parseRate('0.2242')).amountMinor).toBe(0n)
  })
})

describe('toHkdMinor', () => {
  it('passes an HKD amount through unchanged, without needing a rate at all', () => {
    expect(toHkdMinor(150000n, 'HKD', {})).toBe(150000n)
  })

  it('converts a foreign amount using the matching rate', () => {
    // 100.00 USD @ 7.8 = 780.00 HKD
    expect(toHkdMinor(10000n, 'USD', { USD: '7.8' })).toBe(78000n)
  })

  it('is null when the rate table has nothing for that currency, rather than guessing', () => {
    expect(toHkdMinor(10000n, 'USD', {})).toBeNull()
    expect(toHkdMinor(10000n, 'USD', { THB: '0.2242' })).toBeNull()
  })
})

describe('parsing user input', () => {
  it('accepts what a person actually types', () => {
    expect(parseAmountInput('1234.50', 'HKD').amountMinor).toBe(123450n)
    expect(parseAmountInput('1,234.50', 'HKD').amountMinor).toBe(123450n)
    expect(parseAmountInput('  1234.5 ', 'HKD').amountMinor).toBe(123450n)
    expect(parseAmountInput('1234', 'HKD').amountMinor).toBe(123400n)
    expect(parseAmountInput('.5', 'HKD').amountMinor).toBe(50n)
    expect(parseAmountInput('-12.34', 'HKD').amountMinor).toBe(-1234n)
    expect(parseAmountInput('0', 'HKD').amountMinor).toBe(0n)
  })

  it('rejects more precision than the currency has', () => {
    // Silently dropping a digit from an amount is precisely the quiet wrongness
    // this codebase exists to prevent.
    expect(() => parseAmountInput('1.234', 'HKD')).toThrow(/2 decimal places/)
  })

  it('rejects empty and malformed input', () => {
    for (const bad of ['', '   ', '-', '.', 'abc', '1.2.3', '1e5', '$5']) {
      expect(() => parseAmountInput(bad, 'HKD'), JSON.stringify(bad)).toThrow(MoneyError)
    }
  })

  it('round-trips through toDecimalString', () => {
    fc.assert(
      fc.property(anyMinor, anyCurrency, (x, currency) => {
        const original = money(x, currency)
        expect(equals(parseAmountInput(toDecimalString(original), currency), original)).toBe(true)
      }),
    )
  })
})

describe('formatting', () => {
  it('groups thousands and prefixes the symbol', () => {
    expect(formatMoney(money(123450n, 'HKD'))).toBe('HK$1,234.50')
    expect(formatMoney(money(-123450n, 'HKD'))).toBe('-HK$1,234.50')
    expect(formatMoney(money(100000000n, 'THB'))).toBe('฿1,000,000.00')
    expect(formatMoney(money(50n, 'USD'))).toBe('US$0.50')
    expect(formatMoney(money(123450n, 'HKD'), { showSymbol: false })).toBe('1,234.50')
  })
})

describe('JSON codec', () => {
  it('round-trips', () => {
    fc.assert(
      fc.property(anyMinor, anyCurrency, (x, currency) => {
        const original = money(x, currency)
        expect(equals(fromJson(JSON.parse(JSON.stringify(toJson(original)))), original)).toBe(true)
      }),
    )
  })

  it('rejects an unknown currency or a non-integer amount', () => {
    expect(() => fromJson({ amountMinor: '1', currency: 'EUR' as Currency })).toThrow(MoneyError)
    expect(() => fromJson({ amountMinor: '1.5', currency: 'HKD' })).toThrow(MoneyError)
  })

  it('recognises supported currency codes', () => {
    expect(isCurrency('HKD')).toBe(true)
    expect(isCurrency('THB')).toBe(true)
    expect(isCurrency('USD')).toBe(true)
    expect(isCurrency('EUR')).toBe(false)
    expect(isCurrency('toString')).toBe(false)
  })
})
