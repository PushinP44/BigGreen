import { describe, expect, it } from 'vitest'
import {
  accountBalances,
  discretionarySpentInInterval,
  incomeInInterval,
  ledgerIsBalanced,
  liquidHkdMinor,
  netWorth,
  spendByCategory,
  spentInInterval,
  type AccountSnapshot,
  type CategorySnapshot,
  type EntrySnapshot,
} from '@/lib/domain/balances'
import { monthInterval } from '@/lib/domain/clock'
import type { Currency } from '@/lib/domain/money'

const AUG = new Date('2026-08-11T04:00:00Z') // 12:00 HKT
const august = monthInterval(AUG)

function account(
  id: string,
  overrides: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return {
    id,
    kind: 'bank',
    currency: 'HKD',
    isLiquid: true,
    isOwn: true,
    openingBalanceMinor: 0n,
    ...overrides,
  }
}

let nextTransaction = 0

function entry(
  accountId: string,
  amountHkdMinor: bigint,
  overrides: Partial<EntrySnapshot> = {},
): EntrySnapshot {
  const currency = (overrides.currency ?? 'HKD') as Currency
  return {
    transactionId: `txn-${nextTransaction}`,
    accountId,
    amountMinor: overrides.amountMinor ?? amountHkdMinor,
    currency,
    amountHkdMinor,
    occurredAt: AUG,
    status: 'posted',
    categoryId: null,
    isFxResidual: false,
    ...overrides,
  }
}

/**
 * Build one transaction's worth of entries. Spending is a property of a
 * transaction, not an entry, so tests have to model whole transactions or they
 * assert against a shape the engine never sees.
 */
function txn(
  legs: Array<[accountId: string, amountHkdMinor: bigint, overrides?: Partial<EntrySnapshot>]>,
  shared: Partial<EntrySnapshot> = {},
): EntrySnapshot[] {
  nextTransaction += 1
  const transactionId = `txn-${nextTransaction}`
  return legs.map(([accountId, amount, overrides]) =>
    entry(accountId, amount, { ...shared, ...overrides, transactionId }),
  )
}

const bank = account('bank')
const thb = account('thb', { currency: 'THB' })
const card = account('card', { kind: 'credit_card', isLiquid: false })
const broker = account('broker', { kind: 'brokerage', isLiquid: false })
const expenses = account('expenses', { kind: 'expense', isLiquid: false, isOwn: false })
const income = account('income', { kind: 'income', isLiquid: false, isOwn: false })

const accounts = [bank, thb, card, broker, expenses, income]

const categories: CategorySnapshot[] = [
  { id: 'cat-food', name: 'Food', isDiscretionary: true },
  { id: 'cat-rent', name: 'Rent', isDiscretionary: false },
]

describe('accountBalances', () => {
  it('sums posted entries and includes the opening balance', () => {
    const withOpening = [account('bank', { openingBalanceMinor: 100000n }), expenses]
    const balances = accountBalances(withOpening, [
      entry('bank', -12345n),
      entry('expenses', 12345n),
    ])

    expect(balances.get('bank')?.nativeMinor).toBe(87655n)
    expect(balances.get('bank')?.hkdMinor).toBe(-12345n)
  })

  it('ignores scheduled, pending and void entries', () => {
    // A scheduled bill is a future commitment, not money you no longer have.
    // Letting it into a balance is how the app starts disagreeing with a bank.
    const balances = accountBalances(accounts, [
      entry('bank', -100n, { status: 'scheduled' }),
      entry('bank', -200n, { status: 'pending' }),
      entry('bank', -400n, { status: 'void' }),
      entry('bank', -800n, { status: 'posted' }),
    ])
    expect(balances.get('bank')?.hkdMinor).toBe(-800n)
  })

  it('never sums raw minor units across currencies', () => {
    // 1000.50 THB is not 1000.50 of the account's currency. The native figure
    // counts only matching-currency entries; HKD counts everything.
    const balances = accountBalances(accounts, [
      entry('expenses', 22426n, { currency: 'THB', amountMinor: 100050n }),
      entry('expenses', 5000n, { currency: 'HKD', amountMinor: 5000n }),
    ])

    expect(balances.get('expenses')?.nativeMinor).toBe(5000n)
    expect(balances.get('expenses')?.hkdMinor).toBe(27426n)
    expect(balances.get('expenses')?.foreignEntryCount).toBe(1)
  })

  it('ignores entries against an account it does not know', () => {
    const balances = accountBalances([bank], [entry('ghost', -100n)])
    expect(balances.get('bank')?.hkdMinor).toBe(0n)
    expect(balances.has('ghost')).toBe(false)
  })
})

describe('liquid and net worth', () => {
  it('counts only accounts that are both liquid and owned', () => {
    const balances = accountBalances(accounts, [
      entry('bank', 500000n),
      entry('thb', 22426n, { currency: 'THB', amountMinor: 100050n }),
      entry('card', -30000n), // liability, not liquid
      entry('broker', 900000n), // investment, not liquid
      entry('expenses', -1392426n),
    ])

    expect(liquidHkdMinor(accounts, balances)).toBe(522426n)
  })

  it('separates liquid, investments and liabilities', () => {
    const balances = accountBalances(accounts, [
      entry('bank', 500000n),
      entry('card', -30000n),
      entry('broker', 900000n),
      entry('expenses', -1370000n),
    ])

    const nw = netWorth(accounts, balances)
    expect(nw.liquidHkdMinor).toBe(500000n)
    expect(nw.investmentsHkdMinor).toBe(900000n)
    // Card spending credits the liability, so it is already negative — the sign
    // comes from the ledger rather than being applied here.
    expect(nw.liabilitiesHkdMinor).toBe(-30000n)
    expect(nw.totalHkdMinor).toBe(1370000n)
  })

  it('admits when investments are not included', () => {
    const nw = netWorth(accounts, accountBalances(accounts, []))
    expect(nw.includesInvestments).toBe(false)
    expect(netWorth(accounts, accountBalances(accounts, []), { includesInvestments: true })
      .includesInvestments).toBe(true)
  })
})

describe('spending', () => {
  it('reports outflows to the outside world as a positive number', () => {
    const entries = txn([
      ['bank', -12345n],
      ['expenses', 12345n],
    ])
    expect(spentInInterval(accounts, entries, august)).toBe(12345n)
  })

  it('nets a transfer between your own accounts to zero', () => {
    // The whole reason this app is double-entry: moving 5,000 from bank to
    // broker must not read as 5,000 of spending.
    const entries = txn([
      ['bank', -500000n],
      ['broker', 500000n],
    ])
    expect(spentInInterval(accounts, entries, august)).toBe(0n)
  })

  it('does not let income cancel out spending', () => {
    // The bug this pins: netting every owned entry made a month with 50,000 of
    // salary report zero spending. Grouping by transaction is what separates
    // "money crossed the boundary outward" from "the month went well".
    const entries = [
      ...txn([
        ['bank', 5000000n],
        ['income', -5000000n],
      ]),
      ...txn([
        ['bank', -12345n],
        ['expenses', 12345n],
      ]),
    ]

    expect(incomeInInterval(accounts, entries, august)).toBe(5000000n)
    expect(spentInInterval(accounts, entries, august)).toBe(12345n)
  })

  it('does not let a transfer register as spending just because one leg is negative', () => {
    // The mirror-image bug: summing only negative entries would call this
    // 500,000 of spending.
    const entries = [
      ...txn([
        ['bank', -500000n],
        ['broker', 500000n],
      ]),
      ...txn([
        ['bank', -12345n],
        ['expenses', 12345n],
      ]),
    ]
    expect(spentInInterval(accounts, entries, august)).toBe(12345n)
  })

  it('handles a cross-currency transfer as a transfer', () => {
    const entries = txn([
      ['bank', -78321n, { currency: 'HKD', amountMinor: -78321n }],
      ['thb', 78321n, { currency: 'THB', amountMinor: 349400n }],
    ])
    expect(spentInInterval(accounts, entries, august)).toBe(0n)
    expect(incomeInInterval(accounts, entries, august)).toBe(0n)
  })

  it('excludes transactions outside the interval', () => {
    const july = new Date('2026-07-15T04:00:00Z')
    const entries = txn(
      [
        ['bank', -12345n],
        ['expenses', 12345n],
      ],
      { occurredAt: july },
    )
    expect(spentInInterval(accounts, entries, august)).toBe(0n)
  })

  it('respects the Hong Kong month boundary', () => {
    // 2026-08-01 00:30 HKT is 2026-07-31 16:30 UTC. Bucketing in UTC would file
    // this under July and quietly understate August every single month.
    const firstOfAugustHkt = new Date('2026-07-31T16:30:00Z')
    expect(
      spentInInterval(
        accounts,
        txn(
          [
            ['bank', -9900n],
            ['expenses', 9900n],
          ],
          { occurredAt: firstOfAugustHkt },
        ),
        august,
      ),
    ).toBe(9900n)

    const lastOfJulyHkt = new Date('2026-07-31T15:30:00Z') // 23:30 HKT, one hour earlier
    expect(
      spentInInterval(
        accounts,
        txn(
          [
            ['bank', -9900n],
            ['expenses', 9900n],
          ],
          { occurredAt: lastOfJulyHkt },
        ),
        august,
      ),
    ).toBe(0n)
  })

  it('counts only discretionary categories for the budget term', () => {
    const entries = [
      ...txn(
        [
          ['bank', -20000n],
          ['expenses', 20000n],
        ],
        { categoryId: 'cat-food' },
      ),
      ...txn(
        [
          ['bank', -800000n],
          ['expenses', 800000n],
        ],
        { categoryId: 'cat-rent' },
      ),
      ...txn([
        ['bank', -5000n],
        ['expenses', 5000n],
      ]),
    ]
    expect(discretionarySpentInInterval(accounts, entries, categories, august)).toBe(20000n)
  })

  it('groups spending by category, largest first', () => {
    const entries = [
      ...txn([['bank', -20000n], ['expenses', 20000n]], { categoryId: 'cat-food' }),
      ...txn([['bank', -5000n], ['expenses', 5000n]], { categoryId: 'cat-food' }),
      ...txn([['bank', -800000n], ['expenses', 800000n]], { categoryId: 'cat-rent' }),
      ...txn([['bank', -300n], ['expenses', 300n]]),
    ]

    const totals = spendByCategory(accounts, entries, categories, august)
    expect(totals).toEqual([
      { categoryId: 'cat-rent', name: 'Rent', hkdMinor: 800000n },
      { categoryId: 'cat-food', name: 'Food', hkdMinor: 25000n },
      { categoryId: null, name: 'Uncategorised', hkdMinor: 300n },
    ])
  })

  it('excludes a transfer from the category chart entirely', () => {
    const entries = txn([['bank', -500000n], ['broker', 500000n]], { categoryId: 'cat-food' })
    expect(spendByCategory(accounts, entries, categories, august)).toEqual([])
  })
})

describe('ledgerIsBalanced', () => {
  it('holds for a well-formed ledger', () => {
    expect(ledgerIsBalanced([entry('bank', -12345n), entry('expenses', 12345n)])).toBe(true)
  })

  it('fails loudly when it does not', () => {
    expect(ledgerIsBalanced([entry('bank', -12345n), entry('expenses', 12344n)])).toBe(false)
  })

  it('ignores voided entries', () => {
    expect(
      ledgerIsBalanced([
        entry('bank', -12345n),
        entry('expenses', 12345n),
        entry('bank', -999n, { status: 'void' }),
      ]),
    ).toBe(true)
  })
})
