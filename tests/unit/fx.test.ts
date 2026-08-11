import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  assertPlausibleRate,
  assertRateContinuity,
  balanceEntries,
  entriesSumToZero,
  FxError,
  invertRate,
  rateToBase,
  toBase,
  type EntryInput,
  type RateTable,
} from '@/lib/domain/fx'
import { money, parseRate, RATE_ONE, rateToString, type Currency } from '@/lib/domain/money'

const FX_ROUNDING = 'acct-fx-rounding'
const FX_GAIN_LOSS = 'acct-fx-gain-loss'
const opts = { fxRoundingAccountId: FX_ROUNDING }

const usdRate = parseRate('7.83210000')
const thbRate = parseRate('0.22415000')

const table: RateTable = {
  USD: { base: 'USD', quote: 'HKD', asOf: '2026-08-11', rate: usdRate, source: 'frankfurter' },
  THB: { base: 'THB', quote: 'HKD', asOf: '2026-08-11', rate: thbRate, source: 'frankfurter' },
}

function entry(
  accountId: string,
  amountMinor: bigint,
  currency: Currency,
  rate = RATE_ONE,
): EntryInput {
  return { accountId, amountMinor, currency, fxRateToHkd: rate }
}

describe('rate lookup', () => {
  it('converts the base currency to itself at exactly 1, without the table', () => {
    expect(rateToBase('HKD', {})).toEqual(RATE_ONE)
  })

  it('reads a foreign rate from the table', () => {
    expect(rateToString(rateToBase('USD', table))).toBe('7.83210000')
  })

  it('throws when a rate is missing rather than guessing one', () => {
    expect(() => rateToBase('USD', {})).toThrow(/no USD\/HKD rate/)
  })

  it('rejects a table entry quoting the wrong currency', () => {
    const wrong: RateTable = {
      USD: { base: 'USD', quote: 'THB', asOf: '2026-08-11', rate: usdRate, source: 'manual' },
    }
    expect(() => rateToBase('USD', wrong)).toThrow(/quotes THB/)
  })

  it('converts an amount to base', () => {
    expect(toBase(money(10000n, 'USD'), table).amountMinor).toBe(78321n)
    expect(toBase(money(500n, 'HKD'), table).amountMinor).toBe(500n)
  })
})

describe('rate validation (PLAN §11 — a broken feed must fail, not reprice)', () => {
  it('rejects zero, negative and absurd rates', () => {
    expect(() => assertPlausibleRate(parseRate('0'), 'test')).toThrow(FxError)
    expect(() => assertPlausibleRate(parseRate('-7.8'), 'test')).toThrow(FxError)
    expect(() => assertPlausibleRate(parseRate('999999'), 'test')).toThrow(/plausible band/)
  })

  it('accepts real rates', () => {
    expect(() => assertPlausibleRate(usdRate, 'test')).not.toThrow()
    expect(() => assertPlausibleRate(thbRate, 'test')).not.toThrow()
  })

  it('accepts an ordinary daily move', () => {
    expect(() =>
      assertRateContinuity(parseRate('7.8321'), parseRate('7.8402'), 'USD/HKD'),
    ).not.toThrow()
  })

  it('rejects a move that means the feed changed units', () => {
    // 0.22415 → 224.15 is a unit change, not a market move.
    expect(() => assertRateContinuity(thbRate, parseRate('224.15'), 'THB/HKD')).toThrow(
      /broken feed/,
    )
  })

  it('inverts a rate', () => {
    // 1 / 7.8321 = 0.127679677..., half-even at 8dp
    expect(rateToString(invertRate(usdRate))).toBe('0.12767968')
  })
})

describe('balanceEntries — single currency (the common path)', () => {
  it('balances a plain two-entry HKD transaction with no residual', () => {
    const result = balanceEntries(
      [entry('acct-bank', -12345n, 'HKD'), entry('acct-groceries', 12345n, 'HKD')],
      opts,
    )
    expect(result.residualMinor).toBe(0n)
    expect(result.entries).toHaveLength(2)
    expect(result.entries.some((e) => e.isFxResidual)).toBe(false)
    expect(entriesSumToZero(result.entries)).toBe(true)
  })

  it('refuses to absorb a single-currency imbalance', () => {
    // Without this guard, a 2-minor-unit typo across 3 HKD legs would be
    // silently booked to FX Rounding and never seen again.
    expect(() =>
      balanceEntries(
        [
          entry('a', -10000n, 'HKD'),
          entry('b', 5000n, 'HKD'),
          entry('c', 5002n, 'HKD'),
        ],
        opts,
      ),
    ).toThrow(/single-currency transaction does not balance/)
  })

  it('requires at least two entries', () => {
    expect(() => balanceEntries([entry('a', 0n, 'HKD')], opts)).toThrow(/at least 2 entries/)
  })

  it('rejects an HKD entry carrying a rate other than 1', () => {
    expect(() =>
      balanceEntries([entry('a', -100n, 'HKD', usdRate), entry('b', 100n, 'HKD')], opts),
    ).toThrow(/must carry rate 1/)
  })

  it('rejects an implausible rate on a foreign entry', () => {
    expect(() =>
      balanceEntries([entry('a', -100n, 'USD', parseRate('0')), entry('b', 100n, 'HKD')], opts),
    ).toThrow(FxError)
  })
})

describe('balanceEntries — multi-currency (HKD · THB · USD are all live)', () => {
  it('balances a same-currency foreign transaction exactly', () => {
    // Spending THB from a THB account: both legs use the same rate, so the
    // conversion cancels and no residual arises.
    const result = balanceEntries(
      [entry('acct-thb', -100000n, 'THB', thbRate), entry('acct-food', 100000n, 'THB', thbRate)],
      opts,
    )
    expect(result.residualMinor).toBe(0n)
    expect(entriesSumToZero(result.entries)).toBe(true)
  })

  it('books arithmetic residue to FX Rounding when a foreign bill is split', () => {
    // Pay 100.00 THB and split it across two categories. The THB legs sum to
    // exactly zero, but each converts and rounds independently:
    //   -10000 × 0.22415 = -2241.50 → -2242  (half-even)
    //     3333 × 0.22415 =   747.19 →   747
    //     6667 × 0.22415 =  1494.30 →  1494
    // ...leaving 1 minor unit that is arithmetic, not money.
    const result = balanceEntries(
      [
        entry('acct-thb', -10000n, 'THB', thbRate),
        entry('cat-food', 3333n, 'THB', thbRate),
        entry('cat-drinks', 6667n, 'THB', thbRate),
      ],
      opts,
    )

    expect(result.residualMinor).toBe(-1n)
    expect(result.isRounding).toBe(true)
    expect(entriesSumToZero(result.entries)).toBe(true)

    const residualEntries = result.entries.filter((e) => e.isFxResidual)
    expect(residualEntries).toHaveLength(1)
    expect(residualEntries[0]?.accountId).toBe(FX_ROUNDING)
    expect(residualEntries[0]?.currency).toBe('HKD')
    expect(residualEntries[0]?.amountHkdMinor).toBe(1n)
  })

  it('refuses a real cross-currency gap unless the caller opts in', () => {
    // Move 100.00 USD out, 3,494.00 THB in. At reference rates that is a ~3
    // cent HKD gap — the bank's spread. It is real money, so it must not be
    // silently swept into FX Rounding.
    const transfer = [
      entry('acct-usd', -10000n, 'USD', usdRate),
      entry('acct-thb', 349400n, 'THB', thbRate),
    ]

    expect(() => balanceEntries(transfer, opts)).toThrow(/pass fxGainLossAccountId/)
  })

  it('books a real spread to FX Gain/Loss when the caller opts in', () => {
    const result = balanceEntries(
      [entry('acct-usd', -10000n, 'USD', usdRate), entry('acct-thb', 349400n, 'THB', thbRate)],
      { ...opts, fxGainLossAccountId: FX_GAIN_LOSS },
    )

    expect(result.isRounding).toBe(false)
    expect(entriesSumToZero(result.entries)).toBe(true)

    const booked = result.entries.at(-1)
    expect(booked?.accountId).toBe(FX_GAIN_LOSS)
    // Flagged as a real entry, not residue — it shows up in reporting.
    expect(booked?.isFxResidual).toBe(false)
    expect(booked?.amountHkdMinor).toBe(-result.residualMinor)
  })

  it('rejects a typo even when the caller opted in', () => {
    // 100 USD out, 1 THB in: a ~783 HKD gap on a 783 HKD transaction. No bank
    // charges 100%, so this is a mistyped amount.
    expect(() =>
      balanceEntries(
        [entry('acct-usd', -10000n, 'USD', usdRate), entry('acct-thb', 100n, 'THB', thbRate)],
        { ...opts, fxGainLossAccountId: FX_GAIN_LOSS },
      ),
    ).toThrow(/typo, not a spread/)
  })

  it('always sums to exactly zero for any set of legs that balance in their own currency', () => {
    // The invariant the deferred constraint trigger enforces at COMMIT. If this
    // property fails, legitimate writes start failing in production.
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.constantFrom<Currency>('USD', 'THB', 'HKD'),
        (amounts, currency) => {
          const rate = currency === 'USD' ? usdRate : currency === 'THB' ? thbRate : RATE_ONE
          // Force an exact zero in the transaction's own currency, which is what
          // a correctly-constructed transaction always looks like.
          const settle = -amounts.reduce((acc, x) => acc + x, 0n)
          const legs = [...amounts, settle].map((amount, i) =>
            entry(`leg-${i}`, amount, currency, rate),
          )

          const result = balanceEntries(legs, opts)

          expect(entriesSumToZero(result.entries)).toBe(true)
          expect(result.isRounding).toBe(true)

          const magnitude =
            result.residualMinor < 0n ? -result.residualMinor : result.residualMinor
          expect(magnitude <= BigInt(legs.length)).toBe(true)
          // HKD never rounds, so it must never produce a residual at all.
          if (currency === 'HKD') expect(result.residualMinor).toBe(0n)
        },
      ),
      { numRuns: 300 },
    )
  })
})
