# Big Green

Personal money tracker across platforms. Base currency HKD.

**Read `docs/PLAN.md` before doing any work.** It contains the data model, the safe/unsafe
rule, the ingest architecture, and the phase order. Do not improvise around it.

## Non-negotiables

1. **Money is `BIGINT` minor units + ISO currency code.** Never a float, never a JS `number`
   for an amount. FX rate is captured at event time and frozen on the entry.
2. **Double-entry.** Every transaction has ≥2 entries summing to zero in HKD. Transfers
   between two `is_own` accounts must not read as income or spending. Multi-currency
   transactions balance via an explicit `FX Rounding` residual entry — see §3.
3. **Domain rules are pure functions** in `lib/domain/` with no I/O and **no clock access**.
   `now` and the timezone are always explicit arguments. Business logic never lives in a
   React component or a route handler body.
4. **All date bucketing is `Asia/Hong_Kong`.** "Today", "this month", and the committed
   horizon go through `lib/domain/clock.ts`. Never bucket in UTC.
5. **Manual entry is the product, not the fallback.** No CSV/statement/PDF import, no parsers,
   no `inbox_items` — cut by owner instruction, "keep it clean and easy". Entry speed is a
   first-class feature. Anything not typed by the user arrives as `status='pending'` and is
   confirmed before it posts; nothing writes `posted` directly.
6. **Idempotency is structural**, not defensive: `UNIQUE (user_id, source, external_id)` on
   transactions, `UNIQUE (trigger_transaction_id)` on allocation suggestions.
7. **`holdings` is a derived read model**, never written directly. Positions come from
   `entries` carrying `instrument_id` + `quantity_delta`. `avg_cost` is nullable — an unknown
   cost basis renders as `COST UNKNOWN`, never as zero.
8. **RLS on every table**, `user_id` denormalised onto each, tested. Service-role key is
   server-only and never in a `NEXT_PUBLIC_` variable. Public signup is disabled.
9. **Currencies HKD (base), THB, USD are all live.** Multi-currency is a real path, not
   dormant plumbing — the three-currency FX-residual case gets tested hardest.

## Stack

Next.js (App Router) · TypeScript · Supabase (Postgres/Auth/RLS) · Drizzle · Tailwind +
shadcn/ui · Recharts · Vitest + fast-check · PGlite (schema/RLS tests, no Docker) · Playwright ·
Vercel. FX from Frankfurter/ECB, free and overridable. Optional Apple Pay tap capture (P5).

Schema has one authoring surface: Drizzle in `lib/db/schema.ts` → `drizzle-kit generate` →
`supabase/migrations/`. Generated SQL is committed and never hand-edited; RLS policies and
constraint triggers are separate hand-written migrations.

## Testing bar

`lib/domain/` at 100% branch coverage. Property tests for ledger balance, safety monotonicity,
minor-unit round-trips, and reconciler idempotency. Timezone tests on month boundaries.
Idempotency replay tests on every ingest path. A permanent regression test that a materialised
scheduled bill plus its posted payment counts once, not twice. CI blocks merge on typecheck,
lint, unit, migration up/down, and secret scan.

## Tooling

ECC is installed at project scope in `.claude/` (`developer` profile). See §12 of
`docs/PLAN.md` for which agents and skills to reach for. ECC hooks are installed but **not**
wired into `.claude/settings.json` — they are inactive by design until reviewed.
