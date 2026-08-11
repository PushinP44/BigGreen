/**
 * Drizzle schema — the authoring surface for the database.
 *
 * PLAN.md §2: this file is where tables and columns are authored;
 * `drizzle-kit generate` emits SQL into `supabase/migrations/`, and that SQL is
 * the deployed artefact. Generated migrations are committed and never
 * hand-edited. RLS policies, the deferred zero-sum trigger and views are things
 * Drizzle does not model — they live in separate hand-written migrations.
 */

import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// ── Enums ───────────────────────────────────────────────────────────────────

/**
 * `is_own` accounts are the ones you control. The three non-own kinds
 * (equity/expense/income) represent the world outside your balance sheet, and
 * are what give every transaction a counterparty leg without a nullable
 * `account_id`. This is also exactly the test the allocation rule uses to tell
 * new money from your own money moving around (PLAN §8).
 */
export const accountKind = pgEnum('account_kind', [
  'cash',
  'bank',
  'credit_card',
  'ewallet',
  'brokerage',
  'equity',
  'expense',
  'income',
])

export const transactionStatus = pgEnum('transaction_status', [
  'scheduled',
  'pending',
  'posted',
  'void',
])

export const transactionSource = pgEnum('transaction_source', ['manual', 'shortcut', 'recurrence'])

export const instrumentKind = pgEnum('instrument_kind', [
  'stock',
  'etf',
  'index_fund',
  'mutual_fund',
])

export const suggestionState = pgEnum('suggestion_state', [
  'pending',
  'accepted',
  'dismissed',
  'expired',
])

// Currencies are constrained by CHECK rather than an enum: adding a currency
// should be a migration, not an enum alter that rewrites dependent types.
const CURRENCY_CHECK = sql`currency in ('HKD', 'THB', 'USD')`

const userId = () => uuid('user_id').notNull()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

// ── Accounts ────────────────────────────────────────────────────────────────

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    name: text('name').notNull(),
    kind: accountKind('kind').notNull(),
    /** hsbc | za | mox | octopus | payme | manual — drives grouping and seeding. */
    institution: text('institution'),
    currency: char('currency', { length: 3 }).notNull(),
    isLiquid: boolean('is_liquid').notNull().default(false),
    isOwn: boolean('is_own').notNull().default(false),
    // `sql` default rather than a bigint literal: drizzle-kit serialises the
    // snapshot to JSON, which cannot represent a BigInt.
    openingBalanceMinor: bigint('opening_balance_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * Marks the two system accounts the FX policy books to (PLAN §3). Unique per
     * user so the balancing code can find them without a name lookup.
     */
    systemRole: text('system_role'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('accounts_currency_check', CURRENCY_CHECK),
    // Money you do not control is never part of your liquidity. Enforcing this
    // in the database means the safety rule cannot be fed a nonsense snapshot.
    check('accounts_liquid_implies_own', sql`not ${t.isLiquid} or ${t.isOwn}`),
    index('accounts_user_idx').on(t.userId),
    uniqueIndex('accounts_system_role_idx')
      .on(t.userId, t.systemRole)
      .where(sql`system_role is not null`),
  ],
)

// ── Categories ──────────────────────────────────────────────────────────────

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    /** Drives the CAUTION band in the safety rule (PLAN §5). */
    isDiscretionary: boolean('is_discretionary').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('categories_user_idx').on(t.userId)],
)

// ── Transactions ────────────────────────────────────────────────────────────

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    bookedAt: timestamp('booked_at', { withTimezone: true }),
    status: transactionStatus('status').notNull().default('posted'),
    description: text('description'),
    merchant: text('merchant'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    source: transactionSource('source').notNull().default('manual'),
    externalId: text('external_id'),
    notes: text('notes'),
    /**
     * Set when this row was superseded by another — a materialised `scheduled`
     * bill matched to the posted payment. Without this the safety rule and the
     * monthly spend both count the same money (PLAN §7.4).
     */
    reconciledWithId: uuid('reconciled_with_id'),
    createdAt: createdAt(),
  },
  (t) => [
    // Idempotency is structural, not defensive (PLAN D3).
    uniqueIndex('transactions_source_external_idx')
      .on(t.userId, t.source, t.externalId)
      .where(sql`external_id is not null`),
    index('transactions_user_occurred_idx').on(t.userId, t.occurredAt),
    index('transactions_status_idx').on(t.userId, t.status),
  ],
)

// ── Entries ─────────────────────────────────────────────────────────────────

export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Frozen at event time and never recomputed (PLAN D2). */
    fxRateToHkd: numeric('fx_rate_to_hkd', { precision: 18, scale: 8 }).notNull(),
    amountHkdMinor: bigint('amount_hkd_minor', { mode: 'bigint' }).notNull(),
    /** True for the synthetic leg absorbing conversion rounding. */
    isFxResidual: boolean('is_fx_residual').notNull().default(false),
    /**
     * Set on investment legs. These two columns are what make `holdings` a
     * derived read model rather than a second writer that drifts (PLAN §3).
     */
    instrumentId: uuid('instrument_id'),
    quantityDelta: numeric('quantity_delta', { precision: 28, scale: 10 }),
    createdAt: createdAt(),
  },
  (t) => [
    check('entries_currency_check', CURRENCY_CHECK),
    check('entries_fx_rate_positive', sql`${t.fxRateToHkd} > 0`),
    // An instrument without a quantity (or the reverse) is a half-written
    // investment leg, and holdings would silently under-report.
    check(
      'entries_instrument_quantity_together',
      sql`(${t.instrumentId} is null) = (${t.quantityDelta} is null)`,
    ),
    index('entries_transaction_idx').on(t.transactionId),
    index('entries_account_idx').on(t.userId, t.accountId),
    index('entries_instrument_idx').on(t.userId, t.instrumentId),
  ],
)

// ── Instruments and prices ──────────────────────────────────────────────────

export const instruments = pgTable(
  'instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    symbol: text('symbol').notNull(),
    isin: text('isin'),
    kind: instrumentKind('kind').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    exchange: text('exchange'),
    createdAt: createdAt(),
  },
  (t) => [
    check('instruments_currency_check', CURRENCY_CHECK),
    uniqueIndex('instruments_user_symbol_idx').on(t.userId, t.symbol),
  ],
)

export const prices = pgTable(
  'prices',
  {
    userId: userId(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    asOf: date('as_of').notNull(),
    closeMinor: bigint('close_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** 'manual' for HK positions by decision (PLAN §13). */
    source: text('source').notNull().default('manual'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.instrumentId, t.asOf] }),
    check('prices_currency_check', CURRENCY_CHECK),
    check('prices_close_non_negative', sql`${t.closeMinor} >= 0`),
  ],
)

export const fxRates = pgTable(
  'fx_rates',
  {
    userId: userId(),
    /** base/quote is the price of one `base` unit in `quote` units. */
    base: char('base', { length: 3 }).notNull(),
    quote: char('quote', { length: 3 }).notNull(),
    asOf: date('as_of').notNull(),
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    source: text('source').notNull().default('frankfurter'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.base, t.quote, t.asOf] }),
    check('fx_rates_positive', sql`${t.rate} > 0`),
    check('fx_rates_distinct', sql`${t.base} <> ${t.quote}`),
  ],
)

// ── Recurrences ─────────────────────────────────────────────────────────────

export const recurrences = pgTable(
  'recurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    templateTransactionId: uuid('template_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    rrule: text('rrule').notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('recurrences_due_idx').on(t.userId, t.active, t.nextRunAt)],
)

// ── Allocation ──────────────────────────────────────────────────────────────

export const allocationSuggestions = pgTable(
  'allocation_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    /**
     * UNIQUE, and that is the entire double-firing guard (PLAN §8). It also
     * makes editing an inflow unable to retroactively generate advice you never
     * received — structural rather than a rule someone has to remember.
     */
    triggerTransactionId: uuid('trigger_transaction_id')
      .notNull()
      .unique()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    inflowHkdMinor: bigint('inflow_hkd_minor', { mode: 'bigint' }).notNull(),
    suggestedHkdMinor: bigint('suggested_hkd_minor', { mode: 'bigint' }).notNull(),
    ruleVersion: text('rule_version').notNull(),
    state: suggestionState('state').notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    dismissReason: text('dismiss_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    // A suggestion larger than the inflow is nonsense; cap it in the database
    // so no future caller can produce one.
    check(
      'allocation_within_inflow',
      sql`${t.suggestedHkdMinor} >= 0 and ${t.suggestedHkdMinor} <= ${t.inflowHkdMinor}`,
    ),
    index('allocation_state_idx').on(t.userId, t.state),
  ],
)

// ── Operational ─────────────────────────────────────────────────────────────

export const ingestSources = pgTable(
  'ingest_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    sourceKey: text('source_key').notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    expectedIntervalMinutes: integer('expected_interval_minutes').notNull().default(1440),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  },
  (t) => [uniqueIndex('ingest_sources_key_idx').on(t.userId, t.sourceKey)],
)

export const ruleSettings = pgTable(
  'rule_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    /**
     * Versioned so changing a threshold does not rewrite the history of
     * decisions already made under the old one (PLAN §8).
     */
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rule_settings_key_from_idx').on(t.userId, t.key, t.effectiveFrom)],
)

// ── Relations ───────────────────────────────────────────────────────────────

export const transactionsRelations = relations(transactions, ({ many, one }) => ({
  entries: many(entries),
  category: one(categories, {
    fields: [transactions.categoryId],
    references: [categories.id],
  }),
}))

export const entriesRelations = relations(entries, ({ one }) => ({
  transaction: one(transactions, {
    fields: [entries.transactionId],
    references: [transactions.id],
  }),
  account: one(accounts, {
    fields: [entries.accountId],
    references: [accounts.id],
  }),
}))

export const accountsRelations = relations(accounts, ({ many }) => ({
  entries: many(entries),
}))

export type Account = typeof accounts.$inferSelect
export type NewAccount = typeof accounts.$inferInsert
export type Transaction = typeof transactions.$inferSelect
export type NewTransaction = typeof transactions.$inferInsert
export type Entry = typeof entries.$inferSelect
export type NewEntry = typeof entries.$inferInsert
export type Category = typeof categories.$inferSelect
