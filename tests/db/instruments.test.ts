import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createInstrument,
  recordLegacyPosition,
  recordTrade,
  setInstrumentWeight,
  voidPosition,
} from '@/lib/ledger/instruments'
import { computeHoldings, parseQuantity } from '@/lib/domain/holdings'
import { listRecentPositions } from '@/lib/read/holdings'
import type { Db } from '@/lib/db/client'
import { createTestDb, seedAccounts, USER_A, type TestDb } from '../support/db'

let testDb: TestDb
let db: Db
let brokerageId: string
let openingEquityId: string

beforeEach(async () => {
  testDb = await createTestDb()
  // Needed for the fx_rounding system account recordTrade/recordLegacyPosition
  // look up internally; the bank/expense/income ids it returns aren't used here.
  await seedAccounts(testDb, USER_A)
  db = await testDb.asDb(USER_A)

  const brokerage = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own)
     VALUES ($1, 'IBKR', 'brokerage', 'USD', false, true) RETURNING id`,
    [USER_A],
  )
  brokerageId = brokerage.rows[0]!.id

  const equity = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, kind, currency, is_liquid, is_own, system_role)
     VALUES ($1, 'Opening Equity', 'equity', 'HKD', false, false, 'opening_equity') RETURNING id`,
    [USER_A],
  )
  openingEquityId = equity.rows[0]!.id

  // recordTrade/recordLegacyPosition need a USD/HKD rate for a USD instrument.
  await db.query(
    `INSERT INTO fx_rates (user_id, base, quote, as_of, rate, source)
     VALUES ($1, 'USD', 'HKD', '2026-08-11', 7.8, 'manual')`,
    [USER_A],
  )
})

afterEach(async () => {
  await testDb.close()
})

async function entriesFor(transactionId: string) {
  const result = await db.query<{
    account_id: string
    amount_minor: string | number
    instrument_id: string | null
    quantity_delta: string | null
  }>(
    `SELECT account_id, amount_minor, instrument_id, quantity_delta
       FROM entries WHERE transaction_id = $1`,
    [transactionId],
  )
  return result.rows.map((r) => ({ ...r, amount_minor: String(r.amount_minor) }))
}

async function ledgerSumsToZero(): Promise<boolean> {
  const result = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_hkd_minor), 0)::text AS total FROM entries`,
  )
  return BigInt(result.rows[0]!.total) === 0n
}

describe('createInstrument', () => {
  it('creates an instrument and uppercases the symbol', async () => {
    const { id } = await createInstrument(db, { symbol: 'aapl', kind: 'stock', currency: 'USD' })
    const row = await db.query<{ symbol: string }>('SELECT symbol FROM instruments WHERE id = $1', [id])
    expect(row.rows[0]?.symbol).toBe('AAPL')
  })

  it('refuses a duplicate symbol for the same user', async () => {
    await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    await expect(
      createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' }),
    ).rejects.toThrow(/already exists/)
  })
})

describe('setInstrumentWeight', () => {
  it('sets and clears a weight', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })

    await setInstrumentWeight(db, id, 6000)
    let row = await db.query<{ target_weight_bps: number | null }>(
      'SELECT target_weight_bps FROM instruments WHERE id = $1',
      [id],
    )
    expect(row.rows[0]?.target_weight_bps).toBe(6000)

    await setInstrumentWeight(db, id, null)
    row = await db.query<{ target_weight_bps: number | null }>(
      'SELECT target_weight_bps FROM instruments WHERE id = $1',
      [id],
    )
    expect(row.rows[0]?.target_weight_bps).toBeNull()
  })

  it('rejects a weight outside 0-100%', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    await expect(setInstrumentWeight(db, id, 10001)).rejects.toThrow(/between 0 and 100/)
    await expect(setInstrumentWeight(db, id, -1)).rejects.toThrow(/between 0 and 100/)
  })
})

describe('recordTrade', () => {
  it('buys: writes a cash leg and an instrument leg that balance to zero', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })

    const result = await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '10',
      amount: '1500.00',
      description: 'Buy AAPL',
    })

    const entries = await entriesFor(result.transactionId)
    expect(entries).toHaveLength(2)
    expect(await ledgerSumsToZero()).toBe(true)

    const cashLeg = entries.find((e) => e.instrument_id === null)
    const positionLeg = entries.find((e) => e.instrument_id === id)
    expect(cashLeg?.amount_minor).toBe('-150000')
    expect(positionLeg?.amount_minor).toBe('150000')
    expect(positionLeg?.quantity_delta?.startsWith('10.')).toBe(true)
  })

  it('a buy leaves the brokerage account\'s own balance unchanged — cash converts to position, no new money', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '10',
      amount: '1500.00',
      description: '',
    })

    const balance = await db.query<{ n: string | number }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS n FROM entries WHERE account_id = $1`,
      [brokerageId],
    )
    expect(String(balance.rows[0]!.n)).toBe('0')
  })

  it('sells: reduces quantity without perturbing the remaining average cost', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '10',
      amount: '1500.00', // 150.00/share
      description: '',
    })
    await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'sell',
      quantity: '4',
      amount: '680.00', // sold at 170.00/share — proceeds, not cost
      description: '',
    })

    expect(await ledgerSumsToZero()).toBe(true)

    const legs = await db.query<{ quantity_delta: string; amount_minor: string | number }>(
      `SELECT quantity_delta, amount_minor FROM entries WHERE instrument_id = $1 ORDER BY created_at`,
      [id],
    )
    const holdings = computeHoldings(
      legs.rows.map((r) => ({
        instrumentId: id,
        accountId: brokerageId,
        quantityDelta: r.quantity_delta,
        amountMinor: BigInt(String(r.amount_minor)),
      })),
    )
    expect(holdings[0]?.avgCostMinor).toBe(15000n) // unchanged by the sale
  })

  it('rejects a zero or negative quantity', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    await expect(
      recordTrade(db, {
        instrumentId: id,
        accountId: brokerageId,
        side: 'buy',
        quantity: '0',
        amount: '100',
        description: '',
      }),
    ).rejects.toThrow(/greater than zero/)
  })

  it('replacesTransactionId voids the old position and records the corrected one — an edit', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    const original = await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '10', // typo: meant 5
      amount: '1500.00',
      description: 'Buy AAPL',
    })

    const corrected = await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '5',
      amount: '750.00',
      description: 'Buy AAPL',
      replacesTransactionId: original.transactionId,
    })

    const statuses = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM transactions WHERE id IN ($1, $2)`,
      [original.transactionId, corrected.transactionId],
    )
    const byId = new Map(statuses.rows.map((r) => [r.id, r.status]))
    expect(byId.get(original.transactionId)).toBe('void')
    expect(byId.get(corrected.transactionId)).toBe('posted')

    // The void'd original's entries are excluded, so only the 5-share
    // correction counts toward the position.
    const legs = await db.query<{ quantity_delta: string; amount_minor: string | number }>(
      `SELECT e.quantity_delta, e.amount_minor
         FROM entries e JOIN transactions t ON t.id = e.transaction_id
        WHERE e.instrument_id = $1 AND t.status = 'posted'`,
      [id],
    )
    const holdings = computeHoldings(
      legs.rows.map((r) => ({
        instrumentId: id,
        accountId: brokerageId,
        quantityDelta: r.quantity_delta,
        amountMinor: BigInt(String(r.amount_minor)),
      })),
    )
    expect(holdings[0]?.quantity).toEqual(parseQuantity('5'))
  })

  it('still records the correction even when replacesTransactionId no longer has anything to void', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    // A random, non-existent id — the point is the record must not be
    // blocked by a void that has nothing to do, only best-effort attempted.
    const result = await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '5',
      amount: '750.00',
      description: '',
      replacesTransactionId: crypto.randomUUID(),
    })

    const row = await db.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [
      result.transactionId,
    ])
    expect(row.rows[0]?.status).toBe('posted')
  })
})

describe('recordLegacyPosition', () => {
  it('with a known cost, balances against Opening Equity', async () => {
    const { id } = await createInstrument(db, { symbol: 'VOO', kind: 'etf', currency: 'USD' })

    const result = await recordLegacyPosition(db, {
      instrumentId: id,
      accountId: brokerageId,
      quantity: '5',
      costMinor: 200000n, // 2,000.00
      description: 'Legacy VOO',
    })

    expect(await ledgerSumsToZero()).toBe(true)
    const entries = await entriesFor(result.transactionId)
    const equityLeg = entries.find((e) => e.account_id === openingEquityId)
    expect(equityLeg?.amount_minor).toBe('-200000')
  })

  it('with no cost, the position is COST UNKNOWN, never zero', async () => {
    const { id } = await createInstrument(db, { symbol: 'VOO', kind: 'etf', currency: 'USD' })

    await recordLegacyPosition(db, {
      instrumentId: id,
      accountId: brokerageId,
      quantity: '5',
      costMinor: null,
      description: '',
    })

    const legs = await db.query<{ quantity_delta: string; amount_minor: string | number }>(
      `SELECT quantity_delta, amount_minor FROM entries WHERE instrument_id = $1`,
      [id],
    )
    const holdings = computeHoldings(
      legs.rows.map((r) => ({
        instrumentId: id,
        accountId: brokerageId,
        quantityDelta: r.quantity_delta,
        amountMinor: BigInt(String(r.amount_minor)),
      })),
    )
    expect(holdings[0]?.quantity.scaled).toBeGreaterThan(0n)
    expect(holdings[0]?.avgCostMinor).toBeNull()
  })

  it('replacesTransactionId voids the old legacy entry and records the corrected one', async () => {
    const { id } = await createInstrument(db, { symbol: 'VOO', kind: 'etf', currency: 'USD' })
    const original = await recordLegacyPosition(db, {
      instrumentId: id,
      accountId: brokerageId,
      quantity: '5', // typo: meant 3
      costMinor: 200000n,
      description: 'Legacy VOO',
    })

    await recordLegacyPosition(db, {
      instrumentId: id,
      accountId: brokerageId,
      quantity: '3',
      costMinor: 120000n,
      description: 'Legacy VOO',
      replacesTransactionId: original.transactionId,
    })

    const row = await db.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [
      original.transactionId,
    ])
    expect(row.rows[0]?.status).toBe('void')

    const positions = await listRecentPositions(db)
    expect(positions).toHaveLength(1)
    expect(positions[0]?.quantity.startsWith('3.')).toBe(true)
  })
})

describe('voidPosition', () => {
  it('voids a posted trade, which drops it out of posted-only reads', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    const { transactionId } = await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '10',
      amount: '1500.00',
      description: '',
    })

    expect(await voidPosition(db, transactionId)).toBe(true)

    const row = await db.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [
      transactionId,
    ])
    expect(row.rows[0]?.status).toBe('void')
  })

  it('is not fooled twice — voiding an already-void transaction reports nothing to do', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    const { transactionId } = await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '10',
      amount: '1500.00',
      description: '',
    })

    expect(await voidPosition(db, transactionId)).toBe(true)
    expect(await voidPosition(db, transactionId)).toBe(false)
  })

  it('refuses to void a transaction that is not a position at all', async () => {
    // A plain two-leg spend, no instrument_id anywhere — the shape voidPosition
    // must never touch, since this action is reachable from the portfolio page
    // and must not become a back door for discarding an unrelated transaction.
    // Which two accounts carry the legs is irrelevant to what's being proven,
    // so the already-seeded brokerage/equity accounts stand in rather than
    // seeding a second, colliding set via seedAccounts.
    // The double-entry constraint trigger is deferred to commit, so both
    // inserts must land in one transaction — two separate auto-committing
    // statements would trip it after the first entry alone.
    const transactionId = crypto.randomUUID()
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO transactions (id, user_id, occurred_at, status, description, source)
         VALUES ($1, $2, now(), 'posted', 'Coffee', 'manual')`,
        [transactionId, USER_A],
      )
      for (const [accountId, amountMinor] of [
        [brokerageId, '-3800'],
        [openingEquityId, '3800'],
      ] as const) {
        await tx.query(
          `INSERT INTO entries
             (user_id, transaction_id, account_id, amount_minor, currency,
              fx_rate_to_hkd, amount_hkd_minor, is_fx_residual)
           VALUES ($1, $2, $3, $4, 'HKD', 1, $4, false)`,
          [USER_A, transactionId, accountId, amountMinor],
        )
      }
    })

    expect(await voidPosition(db, transactionId)).toBe(false)
    const row = await db.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [
      transactionId,
    ])
    expect(row.rows[0]?.status).toBe('posted') // untouched
  })
})

describe('listRecentPositions', () => {
  it('tells buy, sell and legacy apart', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '10',
      amount: '1500.00',
      description: 'Initial buy',
    })
    await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'sell',
      quantity: '4',
      amount: '680.00',
      description: 'Partial sell',
    })
    await recordLegacyPosition(db, {
      instrumentId: id,
      accountId: brokerageId,
      quantity: '5',
      costMinor: 200000n,
      description: 'Legacy add',
    })

    const positions = await listRecentPositions(db)
    const byDescription = new Map(positions.map((p) => [p.description, p]))
    expect(byDescription.get('Initial buy')?.mode).toBe('buy')
    expect(byDescription.get('Partial sell')?.mode).toBe('sell')
    expect(byDescription.get('Partial sell')?.quantity.startsWith('-')).toBe(true)
    expect(byDescription.get('Legacy add')?.mode).toBe('legacy')

    // instrumentId/accountId (not just the display symbol/name) are what an
    // edit form needs to pre-select the right dropdown options.
    expect(byDescription.get('Initial buy')?.instrumentId).toBe(id)
    expect(byDescription.get('Initial buy')?.accountId).toBe(brokerageId)
  })

  it('excludes a voided position', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    const { transactionId } = await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '10',
      amount: '1500.00',
      description: 'Typo buy',
    })

    expect(await listRecentPositions(db)).toHaveLength(1)
    await voidPosition(db, transactionId)
    expect(await listRecentPositions(db)).toHaveLength(0)
  })

  it('orders newest first', async () => {
    const { id } = await createInstrument(db, { symbol: 'AAPL', kind: 'stock', currency: 'USD' })
    await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '1',
      amount: '150.00',
      description: 'Older',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    })
    await recordTrade(db, {
      instrumentId: id,
      accountId: brokerageId,
      side: 'buy',
      quantity: '1',
      amount: '150.00',
      description: 'Newer',
      occurredAt: new Date('2026-02-01T00:00:00Z'),
    })

    const positions = await listRecentPositions(db)
    expect(positions.map((p) => p.description)).toEqual(['Newer', 'Older'])
  })
})
