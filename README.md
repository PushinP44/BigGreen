# Big Green

Personal money tracker across platforms. Base currency **HKD**, with THB and USD live.

Read [`docs/PLAN.md`](docs/PLAN.md) before doing any work — it holds the data model, the
safe/unsafe rule, and the phase order. [`CLAUDE.md`](CLAUDE.md) is the short version.

**Status: P0 complete.** Foundation, schema, RLS, domain core, and a working vertical slice.

## Quick start

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3119>. No database setup needed — see below.

## The database

Two drivers behind one interface, chosen by whether `DATABASE_URL` is set.

| `DATABASE_URL` | Driver | Use |
|---|---|---|
| unset | PGlite, persisted to `.pglite/` | Local dev. Migrations applied and accounts seeded on first run. Refuses to start in production. |
| set | postgres.js → Supabase | Everything real. |

Tests always use PGlite in-process, so `pnpm test` needs no Docker, no network, and no
credentials. Each test file gets a genuinely fresh database.

To move to Supabase: create a project, copy `.env.example` to `.env.local`, fill it in, then
apply `supabase/migrations/*.sql` in filename order.

## Commands

```bash
pnpm dev          # dev server on :3119
pnpm test         # unit + schema + RLS + ledger  (118 tests)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm verify       # typecheck + lint + test — run before committing
pnpm db:generate  # regenerate SQL from lib/db/schema.ts
```

## Layout

```
app/                  Next.js App Router — page, server actions, entry form
lib/
  domain/             PURE, no I/O, no clock: money.ts, clock.ts, fx.ts
  db/                 schema.ts (Drizzle, the authoring surface) + client.ts
  read/               read models — query, never decide
  ledger/             writes; orchestration only, all decisions delegated to domain/
supabase/migrations/  the deployed artefact. 0000 generated, 0001 hand-written
tests/
  unit/               domain rules
  db/                 schema, RLS, ledger writes — against PGlite
  support/            test harness
```

## The four rules that shape everything

1. **Money is `bigint` minor units + a currency.** Never a float, never a JS `number`. FX rates
   are frozen onto the entry at event time.
2. **Double-entry.** Every transaction's entries sum to exactly zero HKD, enforced by a deferred
   constraint trigger. Multi-currency transactions balance via an explicit `FX Rounding` residual
   entry; a gap too large to be rounding is a real FX spread and goes to `FX Gain/Loss`.
3. **Domain rules are pure functions** with no I/O and no clock — `now` and the timezone are
   always explicit arguments. That is what makes them testable without a database.
4. **All date bucketing is `Asia/Hong_Kong`.** Never UTC. Bucketing in UTC silently misfiles the
   last eight hours of every month.

## What P0 delivers

- Schema for all 11 tables, RLS on every one, verified by tests that prove a second user reads
  nothing and cannot reach across tenants through a foreign key.
- `money.ts` / `clock.ts` / `fx.ts` at full branch coverage, with property tests.
- A working slice: your real accounts seeded, record a spend or income in any of the three
  currencies, see balances and the `liquid` total update.

Next: **P1** — categories, transfers, duplicate-then-edit, the FX job, dashboard, data export.
