# Big Green

Personal money tracker across platforms. Base currency **HKD**, with THB and USD live.

Read [`docs/PLAN.md`](docs/PLAN.md) before doing any work — it holds the data model, the
safe/unsafe rule, and the phase order. [`CLAUDE.md`](CLAUDE.md) is the short version.

**Status: live on Supabase, with auth.** Foundation, schema, RLS, domain core, ledger,
dashboard with charts, safety engine, credit-card cycles, Gmail ingest, spend-by-category
trends, a portfolio with live US-equity prices, the inflow-allocation engine, Supabase Auth,
and a couple of dashboard-only reactions to money moving. 378 tests.

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
pnpm test         # unit + schema + RLS + ledger + parsers  (378 tests)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm verify       # typecheck + lint + test — run before committing
pnpm db:generate  # regenerate SQL from lib/db/schema.ts
pnpm db:migrate   # apply migrations to DATABASE_URL
pnpm db:seed      # the owner's own accounts (never used by sign-up)
pnpm db:claim <email>   # move pre-auth data to a real signed-in user
```

> TypeScript is pinned to 6.x and ESLint to 9.x on purpose: typescript-eslint does not yet
> support the TS 7 API, and ESLint 10 breaks typescript-eslint 8. Both can move once that
> settles.

## Layout

```
app/                  Next.js App Router — page, server actions, entry form
  charts/             Recharts client components — net worth, category trend
  portfolio/          instruments, buy/sell/legacy positions, target weights
  allocations/        PLAN §8 inflow-suggestion accept/dismiss UI
  settings/advanced/  floors, timing, ingest confidence, credit card terms
lib/
  domain/             PURE, no I/O, no clock: money.ts, clock.ts, fx.ts, holdings.ts, allocation.ts
  db/                 schema.ts (Drizzle, the authoring surface) + client.ts
  read/               read models — query, never decide
  ledger/             writes; orchestration only, all decisions delegated to domain/
  fx/                 external feeds — frankfurter.ts (FX), finnhub.ts (equity prices)
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

**Foundation.** 11 tables, RLS on every one, verified by tests proving a second user reads
nothing and cannot reach across tenants through a foreign key. Deferred constraint trigger
enforcing double-entry at COMMIT. `money` / `clock` / `fx` at full branch coverage.

**Ledger and dashboard.** Balance engine, spend/income/transfer across HKD·THB·USD, categories,
cross-currency transfers booking the bank's spread to `FX Gain/Loss`, free FX from Frankfurter,
JSON/CSV export. A `Data health` panel surfaces every feed's heartbeat (last attempt, last
success, consecutive failures) before you ever click refresh, not just after.

**Charts.** Net worth over time, one line per currency pool — at cost, not mark-to-market, and
labelled as such. A stacked-bar spend trend for the top categories on `/categories`, next to a
table of this month against the trailing 6-month average (dividing only by months the ledger
actually has activity in, not the nominal window — a new ledger's average isn't diluted by
months before it existed).

**Safety.** Per-currency pools — baht in a Thai bank cannot buy lunch in Hong Kong, so each pool
is judged against the money that can actually pay for it. Floor is days of cover rather than a
fixed cushion, so it self-calibrates. Verdicts carry their numbers, live as you type.

**Credit cards.** Real statement cycles, and a revolving-balance model: the minimum payment is
the near-term obligation, the rest is debt whose interest cost is shown rather than discovered
on a statement.

**Portfolio.** Instruments, buy/sell, and legacy positions on `/portfolio` — holdings are
derived from `entries`, never stored directly. Live end-of-day prices for US-listed equities
from Finnhub's free tier; unrecognised or non-US symbols just fall back to whatever manual
price is on record. Unknown cost basis renders as `COST UNKNOWN`, never zero.

**Inflow allocation (PLAN §8).** A ≥2,000 HKD external inflow suggests moving 30% somewhere
other than spending. Accepting schedules a transfer you still have to go make; set a target
weight on an instrument and the suggestion splits across your weighted stocks instead of one
lump sum, with the unweighted remainder falling back to a single account you pick.

**Gmail ingest.** Apps Script poller → HMAC-signed endpoint → parser registry with confidence
scoring. Above the bar it posts itself; below it waits in a review queue that says what it was
unsure about. Idempotent on the Gmail message id.

**Auth.** Supabase magic link, per-user provisioning, account management.

**A couple of dashboard reactions.** Falling dollars on a successful income entry, a brief
full-screen red flash on a spend — both purely decorative, both gone on their own a couple of
seconds later.

## Still open

1. **A redacted HSBC alert.** Everything runs on the generic heuristic parser until there is a
   real sample to write a sender-specific one against.
2. **A persistent cash-vs-invest split** for the 30% inflow rule. Per-stock target weights
   exist and split an accepted suggestion across weighted instruments, but there's no standing
   "10% cash / 20% invested" setting independent of which account you happen to pick as the
   fallback each time you accept one.
3. **A Chrome extension** for Gmail capture, instead of the Apps Script poller. Noted, and
   explicitly secondary while there's one user and the existing path already works.
4. **Everything in [`docs/DEPLOY.md`](docs/DEPLOY.md) under "Before this is public"** — the app
   works well for one person, and several things assume that person is the owner.
