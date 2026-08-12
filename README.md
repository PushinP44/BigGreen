# Big Green

Personal money tracker across platforms. Base currency **HKD**, with THB and USD live.

Read [`docs/PLAN.md`](docs/PLAN.md) before doing any work — it holds the data model, the
safe/unsafe rule, and the phase order. [`CLAUDE.md`](CLAUDE.md) is the short version.

**Status: live on Supabase, with auth.** Foundation, schema, RLS, domain core, ledger,
dashboard, FX feed, export, safety engine, credit-card cycles, Gmail ingest, and Supabase Auth.
304 tests.

Deploying? See [`docs/DEPLOY.md`](docs/DEPLOY.md) — including why Supabase cannot host the app
itself, and what is still single-user before this could go public.

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
pnpm test         # unit + schema + RLS + ledger  (210 tests)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm verify       # typecheck + lint + test — run before committing
pnpm db:generate  # regenerate SQL from lib/db/schema.ts
```

> TypeScript is pinned to 6.x and ESLint to 9.x on purpose: typescript-eslint does not yet
> support the TS 7 API, and ESLint 10 breaks typescript-eslint 8. Both can move once that
> settles.

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

## What's built

**P0 — Foundation.** All 11 tables with RLS on every one, verified by tests that prove a second
user reads nothing and cannot reach across tenants through a foreign key. `money.ts`,
`clock.ts`, `fx.ts` at full branch coverage with property tests. Deferred constraint trigger
enforcing double-entry at COMMIT.

**P1 — Ledger and dashboard.** Balance engine, spend/income/transfer flows across HKD·THB·USD,
categories, cross-currency transfers that book the bank's spread to `FX Gain/Loss`, free FX
from Frankfurter with validation and manual override, dashboard, and a full JSON/CSV export.

**P2 — Safety.** `available = liquid − committed − floor`, with a verdict that always carries
the numbers behind it, live in the entry form as you type. Reconciler that stops a materialised
commitment and its payment being counted twice.

## Still open

Answer these when convenient — none block using the app:

1. **Your real emergency floor and discretionary budget.** Currently 10,000 and 6,000 HKD/month,
   both guesses. They live in `rule_settings` and change in seconds.
2. **Savings vs investing split** for the 30% rule — one sleeve or split, needed before P3.
3. **Email parsing — keep or cut?** Standing recommendation is cut (PLAN §7.0).

Next: **P3** — the allocation rule (≥2,000 HKD inflow → 30% suggestion), then **P4** investments.
