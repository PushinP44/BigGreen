import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createInstrument,
  recordLegacyPosition,
  recordTrade,
  setInstrumentWeight,
} from '@/lib/ledger/instruments'
import { computeHoldings } from '@/lib/domain/holdings'
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
})
