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
5. **Manual entry is the primary path, not the only one.** No CSV/statement/PDF import — that
   stays cut, owner instruction, "keep it clean and easy" (PLAN §1). Gmail ingest
   (`lib/ingest/email.ts`, `lib/parsers/`) is real and shipped: a parsed email at or above
   `autoPostConfidence` (default 0.9, tunable in Settings → Advanced) posts itself; below it,
   it lands as `status='pending'` in `/review` for you to confirm. Entry speed is still a
   first-class feature for the manual path, which remains how most things get in.
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

Next.js (App Router) · TypeScript · Supabase (Postgres/Auth/RLS) · Drizzle · Tailwind v4 +
shadcn/ui · Recharts · Vitest + fast-check · PGlite (schema/RLS tests, no Docker) ·
Vercel. FX from Frankfurter/ECB, free and overridable. Optional Apple Pay tap capture (P5).

**Playwright is not installed.** It is intended (`docs/PLAN.md` §"Verification") but no E2E
suite exists, so authenticated routes are verified by hand or against a local PGlite dev
server — see below. Do not describe E2E coverage this repo does not have.

The UI is shadcn/ui **vendored**, not installed: primitives live in `components/ui/` and there
is no shadcn runtime dependency. `app/globals.css` is hand-authored and must stay that way —
running `shadcn init` over it drops the `.tabular` utility (48 money columns lose tabular
figures, silently) and the three `smart-alert-*` keyframes. `tests/unit/css-contract.test.ts`
guards exactly that and is the app's only UI regression test.

Colour has two layers: a bare-named Big Green palette (`--paper`, `--ink`, `--green`, `--loss`,
`--line`) and the shadcn semantic names built from it (`--background`, `--primary`, `--border`…).
Dark mode overrides the palette, not the semantic layer, so six declarations move about twenty
tokens. Palette names stay outside the `--color-*` prefix, which belongs to Tailwind's `@theme`.

Authenticated routes can be run locally without Supabase: `.claude/launch.json` defines
`big-green-pglite`, which starts the dev server with the Supabase env vars blank and falls back
to PGlite with a seeded user.

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
