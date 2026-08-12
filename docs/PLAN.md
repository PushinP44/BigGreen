# Big Green — Implementation Plan

Personal money tracker across platforms. Base currency **HKD**.

Status: plan approved for build. Last revised 2026-08-12 (rev 4).

Stack: **Next.js (App Router) + TypeScript + Supabase (Postgres/Auth/RLS)**, deployed on Vercel.
Primary input is **manual entry**. Optional Apple Pay tap capture, pending a spike.

Currencies in active use: **HKD (accounting base), USD, THB** — held in three separate pools.

> **Rev 4 made HKD an accounting unit only, and made the floor adaptive.**
>
> **Per-currency pools.** HKD remains the unit the ledger balances in — the zero-sum constraint
> needs a common unit and a cross-currency transfer cannot balance without one. It is no longer
> the unit anything is *reported* in. Balances, net worth and safe-to-spend are per currency.
>
> This is a correctness fix, not a display preference: **THB at KTB cannot buy lunch in Hong
> Kong.** Blending it into a single "safe to spend HK$X" states that money is available today
> when it is days and a spread away — exactly the failure §5 already warns about in the
> credit-card case. Owner's instruction, 2026-08-12: *"no need to make all to HKD."*
>
> **Runway floor.** The emergency floor is `floor_days × daily_burn` rather than a fixed
> amount. A constant cushion is a guess that goes stale silently; days-of-cover self-calibrates
> and the verdict it produces ("this leaves 41 days of cover") answers the question a person is
> actually asking.
>
> **Rev 3 cut the import pipeline.** Owner's instruction, 2026-08-11: *"no need to create csv or
> statement reader since it is for personal use; keep it clean and easy."* Statement/CSV/PDF
> import is out (§1), which removes the parser registry, the golden-fixture apparatus, and most
> of what was P4. Email parsing is deferred pending the same reasoning. Manual entry is now the
> primary input path and is budgeted as a first-class feature, not a fallback.
>
> **Rev 2 changed the ingest architecture.** Rev 1 assumed email was the reliable capture
> channel and built a Cloudflare Email Worker around it. Given the actual institution mix
> (§13) — four of five are push-notification-first — and no domain for Email Routing, email
> stopped being the backbone. §3's FX-residual, timezone, holdings-derivation and
> double-count corrections all date from rev 2 and still stand.

---

## 0. What the original brief said, and what it left open

| Original requirement | Status | Resolution |
|---|---|---|
| Dashboard | Clear | §6 |
| Safe / unsafe payment | **Undefined** — no rule given | Deterministic solvency rule, §5 |
| `+` button: add stock/index/fund, legacy data, spending (scheduled + paid) | Partly clear | Four flows on one sheet, §4 |
| Auto-add via email API or Apple Wallet API | **Partly infeasible as stated** | Real capability boundary in §7 |
| Investment notice when money enters > 2000 HKD, 30% for savings | **Ambiguous** — per-inflow or cumulative? gross or net? transfers count? | Defined in §8 |

### Decisions of record

Made before code, and not to be re-litigated mid-build.

**D1 — Double-entry, not a flat transaction list.**
Without it, moving 5,000 HKD from your bank to your broker looks like a 5,000 expense *and*
a 5,000 inflow. That single bug would fire a false "invest 30%" notice, corrupt the safe/unsafe
verdict, and inflate spending. Double-entry makes internal transfers cancel by construction.
Cost: one extra table and a balance constraint. Worth it.

**D2 — Money is `BIGINT` minor units + an ISO currency code. Never a float.**
`0.1 + 0.2 !== 0.3`. Every amount is an integer (cents) with a currency, plus the FX rate to
HKD captured *at the time of the event* and frozen on the entry.

**D3 — Ingest is a staging pipeline, not a direct write.**
Parsed data lands in `inbox_items` → `draft_transactions` → you confirm → `transactions`.
Nothing auto-parsed ever silently becomes truth. This is what keeps a bad regex from quietly
poisoning six months of history.

**D4 — All date bucketing is `Asia/Hong_Kong`, never UTC.** (New in rev 2.)
"Today", "this month", and the committed-outflow horizon are local-calendar concepts. A UTC
month boundary silently misfiles eight hours of spending every month, and the discretionary
budget is the first thing to go wrong. Timestamps are stored `timestamptz`; every bucketing
decision goes through `lib/domain/clock.ts`, which takes `now` and a timezone as explicit
arguments. Domain functions never call `new Date()` — that is what makes them testable.

**D5 — Manual entry is the product, not the fallback.** (Rev 3, replacing rev 2's three-channel
capture decision.) You enter amounts yourself. That makes entry *speed* a primary feature —
duplicate-then-edit, sensible defaults, a currency picker that remembers, and a keyboard path
that never touches a mouse. Every hour not spent on parsers goes here. Any automatic channel
added later writes a `pending` transaction you confirm; none write `posted` directly.

---

## 1. Scope

**In scope (v1)**

- Single user (you). Multi-user is a schema concern only, not a UI concern.
- Accounts: cash, bank, credit card, e-wallet (Octopus / PayMe), brokerage.
- **Multi-currency: HKD (base), THB, USD.** Live from day one, not dormant plumbing.
- Ledger of paid + scheduled spending, income, transfers.
- Holdings: stocks, index funds, ETFs, mutual funds — including legacy positions with no
  transaction history and, where you don't have it, no cost basis.
- Safe/unsafe verdict before you commit to a payment.
- Inflow allocation rule (the "2000 HKD → 30%" notice).
- **Fast manual entry as the primary input path**, with duplicate-then-edit (§4).

**Explicitly out of scope (v1)** — written down so they don't creep in:

- **CSV / statement / PDF import, and the parser registry that served it.** Cut in rev 3 by
  owner instruction. This also removes `inbox_items`, per-source parser modules, and the
  golden-fixture requirement — roughly the whole of the old P4. Manual entry replaces it.
- **Email receipt parsing (Gmail / Apps Script).** Deferred by the same reasoning; decide at
  the P2 checkpoint. §7.2 is the standing recommendation to drop it.
- Tax reporting; capital-gains lot accounting beyond simple average cost.
- Bank linking via Plaid/aggregator (HK coverage is poor, and it is a paid dependency).
- Real-time intraday quotes. Manual HK prices by choice; free FX by API (§7.3).
- Budget envelopes / zero-based budgeting. The safety rule replaces it for now.
- Credit-card statement-cycle modelling. Deliberately excluded — see §5.
- Sharing, multi-user households, mobile native app.

---

## 2. Architecture

```
   Manual entry (+ sheet, §4) ──────────────┐   PRIMARY PATH
                                            │
   iOS Shortcut (Apple Pay tap) ─── P3 ─────┼──▶ transactions (status='pending')
        optional, pending spike §7.2        │              │
                                            │              │ reconciler §7.4
                                            ▼              ▼
   Next.js dashboard ◀── read models ◀── transactions + entries (double-entry ledger)
                                                           │
                                                           ▼
                                             rules engine: safety, allocation
                                                           │
   Frankfurter / ECB ──▶ fx_rates ──────────────────────────┘
   (free, daily, HKD·THB·USD)
```

Rev 3 removed the `inbox_items` → parser → `draft_transactions` staging chain along with the
import pipeline. **D3 survives in reduced form:** anything not typed by you lands as a
`pending` transaction requiring confirmation, never as `posted`. There is simply no longer a
parser to defend against, so there is no longer a staging table to defend with.

**Why all money logic is server-side.** Every rule (safety, allocation, FX, balances) is a
pure TypeScript module under `lib/domain/` with zero I/O, called from route handlers and
server actions — never from a React component. That makes them unit-testable without a
database and impossible to bypass from the client.

**Schema has exactly one authoring surface.** Rev 1 listed both Drizzle and
`supabase/migrations/` as "source of truth", which is two sources of truth and therefore none.
Resolved:

- `lib/db/schema.ts` (Drizzle) is where you author tables and columns.
- `drizzle-kit generate` emits SQL into `supabase/migrations/`. Generated files are committed,
  reviewed, and **never hand-edited**.
- RLS policies, constraint triggers, and views are things Drizzle does not model. They live in
  hand-written migrations as separate numbered files in the same directory.
- The deployed artifact is always the SQL. Drizzle is the authoring convenience and the type
  source, not the deployment mechanism.

**Repo layout**

```
app/
  (dashboard)/            dashboard, accounts, holdings, spending, review queue
  api/ingest/email/       Apps Script → HMAC-verified receiver
  api/ingest/shortcut/    iOS Shortcut → bearer-token receiver
  api/ingest/import/      statement upload → inbox_items
lib/
  domain/                 PURE, no I/O: money.ts, fx.ts, clock.ts, safety.ts,
                          allocation.ts, balances.ts, reconcile.ts, holdings.ts
  parsers/                one module per source (hsbc_email.ts, mox_csv.ts, ...)
  db/                     drizzle schema (authoring surface + types)
  supabase/               client/server helpers
tools/gmail-ingest/       Apps Script source, version-controlled and clasp-pushed
supabase/migrations/      SQL migrations — the deployed artifact
tests/
  unit/                   domain rules — the ones that must never break
  fixtures/               redacted golden files, one per parser (emails/, statements/)
  e2e/                    Playwright
```

---

## 3. Data model

All money columns: `amount_minor BIGINT NOT NULL`, `currency CHAR(3) NOT NULL`.
**Every table carries `user_id UUID NOT NULL` and an RLS policy scoped to it.** Denormalised
rather than joined-through, because a policy that requires a join is a policy that is slow and
eventually gets an exception carved into it.

```sql
accounts        id, user_id, name, kind, institution, currency,
                is_liquid, is_own, opening_balance_minor, archived_at
-- kind: cash | bank | credit_card | ewallet | brokerage | equity
-- institution: hsbc | za | mox | octopus | payme | manual | ...
--   (drives parser routing and statement-import account matching)
-- is_own = true marks accounts you control. Transfers between two is_own
--   accounts are how the system knows an inflow is NOT new money.
-- is_liquid = false for credit_card (see §5 for the treatment).

transactions    id, user_id, occurred_at, booked_at, status, description,
                merchant, category_id, source, external_id, notes,
                reconciled_with_id
-- status: scheduled | pending | posted | void
-- source: manual | email | shortcut | import
-- UNIQUE (user_id, source, external_id) WHERE external_id IS NOT NULL
--   ← idempotency. Re-ingesting the same receipt is a no-op, not a duplicate.
-- reconciled_with_id: set when this row was merged into / superseded by
--   another (tap-stub → receipt, scheduled → posted). See §7.5.
-- Posted transactions are never hard-deleted. Correct by voiding and
--   re-entering, so the audit trail survives.

entries         id, user_id, transaction_id, account_id,
                amount_minor, currency,
                fx_rate_to_hkd NUMERIC(18,8), amount_hkd_minor,
                instrument_id NULL, quantity_delta NUMERIC(28,10) NULL
-- Every transaction has >= 2 entries. Sum of amount_hkd_minor per
--   transaction MUST equal 0. Enforced by a DEFERRABLE INITIALLY DEFERRED
--   constraint trigger, checked at COMMIT.
-- instrument_id / quantity_delta are set on investment legs. They are what
--   makes holdings derivable rather than separately maintained.

categories      id, user_id, name, parent_id, is_discretionary
-- is_discretionary drives the CAUTION band in the safety rule.

instruments     id, user_id, symbol, isin, kind, currency, exchange
-- kind: stock | etf | index_fund | mutual_fund

prices          user_id, instrument_id, as_of DATE, close_minor, currency,
                source, is_stale
-- PRIMARY KEY (user_id, instrument_id, as_of)
-- source: manual | api:<provider>. HK positions are manual by decision (§7.4).
-- is_stale is derived in the read model, not stored: a price older than
--   7 trading days is displayed with a staleness marker rather than silently.

fx_rates        user_id, base, quote, as_of DATE, rate NUMERIC(18,8), source
-- PRIMARY KEY (user_id, base, quote, as_of)

recurrences     id, user_id, template_transaction_id, rrule TEXT,
                next_run_at, active
-- Scheduled spending. Materialises into status='scheduled' transactions
--   60 days ahead so the safety rule can see them.

-- CUT in rev 3: inbox_items, draft_transactions. With no parsers there is
--   nothing to stage against. Anything not typed by you arrives as a
--   transaction with status='pending' and is confirmed before it posts.

allocation_suggestions  id, user_id, trigger_transaction_id UNIQUE,
                        inflow_hkd_minor, suggested_hkd_minor,
                        rule_version, state, decided_at, dismiss_reason
-- UNIQUE on trigger_transaction_id is the guard against double-firing.

ingest_sources  id, user_id, source_key, last_attempt_at, last_success_at,
                expected_interval_minutes, consecutive_failures
-- Retained but reduced: with import cut, the only entries are the daily FX
--   job and (if §7.2 ships) the tap endpoint. A dead FX job and a stable
--   market look identical without this.

rule_settings   id, user_id, key, value_json, effective_from
-- Thresholds are DATA, not constants. Changing 2000→3000 is a row, not a
--   deploy. Keys:
--     safety.floor_days                 45
--     safety.declared_monthly_spend     seed for daily_burn until measured
--     safety.discretionary_budget       HKD/month, blended (see §5)
--     safety.horizon_days               30
--     safety.burn_window_days           90
--     safety.min_history_days           30 — below this, use the declared burn
--     allocation.threshold              200000 (2,000 HKD)
--     allocation.pct                    0.30
```

### `holdings` is derived, never written

Rev 1 had `holdings` as a table with `quantity` and `avg_cost_minor` columns while investment
activity also flowed through `transactions`. Two writers, one number: guaranteed drift.

Resolved: **`holdings` is a read model** (a SQL view, promoted to materialised only if it ever
gets slow), computed from `entries` where `instrument_id IS NOT NULL`:

```
quantity   = Σ quantity_delta
avg_cost   = Σ (cost legs) / Σ (quantity on cost-bearing legs)
```

A legacy position is an opening entry with `quantity_delta` set and a balancing entry against
an `equity` account — same shape as any other buy, so nothing special-cases it downstream.

**`avg_cost` is nullable and that is a feature.** You have cost basis for some positions and
not others (§13). A position with unknown cost shows `cost unknown` in the UI and is excluded
from P/L totals. It never shows a cost of zero, because a fabricated 100% gain is worse than an
honest blank.

### FX rounding: the zero-sum constraint needs a residual policy

Rev 1 required entries to sum to exactly 0 HKD but converted each entry independently. Those
two requirements are incompatible: convert 3 legs at `NUMERIC(18,8)` and round each to minor
units, and they will not sum to zero. In production, the constraint trigger fires and the write
fails — on a legitimate transaction.

Policy:

1. Convert each entry independently and round half-even to minor units.
2. Compute `residual = Σ amount_hkd_minor`.
3. If `residual != 0`, write one additional entry against a dedicated **`FX Rounding`** equity
   account for `-residual`. It is visible, auditable, and its lifetime total is a health metric.
4. **Assert `|residual| ≤ entry_count`.** A residual larger than one minor unit per leg is not
   rounding, it is a bug — fail loudly rather than absorbing it.

Single-currency transactions produce `residual = 0` and no extra entry, so the common path is
untouched.

---

## 4. The `+` button

One floating action button, four flows behind it. Same sheet, segmented control at top.

1. **Spending** — amount, merchant, category, account, date, and a toggle *Paid* ↔ *Scheduled*.
   Scheduled additionally takes a repeat rule (RRULE) and feeds `recurrences`. Runs the safety
   check live as you type the amount (§5).
2. **Income** — amount, source, account. On save, evaluates the allocation rule (§8).
3. **Investment** — instrument search (symbol/ISIN), buy/sell, quantity, unit price, fees,
   settlement account.
4. **Legacy position** — instrument, quantity, "as of" date, and **optional** average cost.
   Creates the opening entry plus a balancing equity entry so the ledger stays balanced. Leaving
   cost blank is a first-class choice, not an error state: the position counts toward net worth
   and allocation, and simply has no P/L.

Every flow supports **duplicate-then-edit** from a recent item. In practice that is how 80% of
manual entries actually get made — and given that three of your five institutions have no
automatic capture path at all (§7.1), manual entry speed is a primary feature here, not a
fallback. Budget UI effort accordingly.

---

## 5. Safe / unsafe payment

The brief did not define this. Here is a definition that is deterministic, explainable, and
testable — three properties that matter more than sophistication.

### Per currency, not blended

Every term below is computed **within one currency pool** and in that pool's own units. A
payment in THB is judged against your THB, because that is the money that can actually pay it.

| Pool | Accounts | Has a floor? |
|---|---|---|
| **HKD** | HSBC, Mox, ZA (HKD), Octopus, PayMe, HSBC card | Yes — this is where you live |
| **USD** | ZA Bank USD | No by default: savings, not spending money |
| **THB** | KTB | No by default; set one if you spend meaningfully in Thailand |

A pool with no floor still produces a verdict — it just uses `floor = 0`, so UNSAFE means
"this would overdraw you", not "this breaches your cushion". A pool that has no floor says so
rather than implying one.

### The terms

```
liquid      = Σ balances of accounts in this pool where is_liquid AND is_own
committed   = Σ scheduled EXTERNAL outflows with due_date ≤ today + horizon_days
            + Σ outstanding credit-card balances in this pool
floor       = floor_days × daily_burn          ← adaptive, see below
available   = liquid − committed − floor
runway_days = (liquid − committed) / daily_burn
```

**`daily_burn` is declared, then measured.** There is no spending history on day one, so a rule
built on measured averages cannot start. You seed it with a rough monthly figure; once the
ledger holds at least `min_history_days` (default 30), the rule switches to the trailing
`burn_window_days` (default 90) average and the UI says which one it is using. A number derived
from your real spending is better than a number you guessed, but only once it exists.

Defaults: `floor_days = 45`, `horizon_days = 30`. With a declared HK$8,000/month that is a
floor of roughly HK$11,800 — close to rev 1's fixed HK$10,000 guess, which is mildly reassuring
about both.

### The discretionary budget is deliberately *not* per pool

```
discretionary_spent_mtd = Σ posted outflows this month in discretionary categories,
                          across ALL pools, in HKD
discretionary_budget    = setting, in HKD per month
```

This is the one place blending is correct, and the distinction is worth stating plainly:

- **Liquidity is per pool** because you cannot spend baht in Hong Kong. It is a question about
  what money can physically reach a payment.
- **Budget is about behaviour.** Eating out in Bangkok is the same habit as eating out in
  Kowloon, and a budget that let you evade it by crossing a border would be measuring nothing.

All of `today`, `this month`, and the horizon window are evaluated in `Asia/Hong_Kong` (D4).

Verdict for a proposed payment of `amount`, judged against its own currency's pool:

| Condition | Verdict |
|---|---|
| `amount > available` | **UNSAFE** — breaches your floor or a committed bill |
| `amount ≤ available` **and** category is discretionary **and** `discretionary_spent_mtd + amount > discretionary_budget` | **CAUTION** — affordable, but over budget |
| otherwise | **SAFE** |

### Credit cards: deliberately simple

Rev 1 required cards to count as liquidity up to the un-billed portion. That is the more
accurate model, but it needs `credit_limit`, `statement_day` and `payment_due_day` on accounts
plus statement-period logic in the rule — and you have said cards are not a large part of your
spending. So:

> A credit card is a liability account (`is_liquid = false`). Its **full outstanding balance
> counts as committed**, with no statement-cycle awareness.

This is deliberately **conservative**: it can understate `available` for someone who pays in
full each month, because next month's not-yet-billed spending is treated as due now. It cannot
overstate it — and overstating is the failure mode that matters, because that is the one that
tells you you're rich when you aren't.

**Two double-counting traps, both closed:**

- Card *spending* debits an expense and credits the card. It never touches `liquid`, so the
  balance appearing in `committed` is not a second count.
- A scheduled *card payment* is a transfer between two `is_own` accounts settling a liability
  already counted in `committed`. **Transfers between own accounts are excluded from
  `committed` entirely** — hence "scheduled EXTERNAL outflows" above.

Upgrade path if it starts to annoy you: add the three cycle fields and a
`credit_model: simple | cycle` setting. The rule signature does not change.

### Other constraints on this rule

- `available` may be negative. The UI states the shortfall plainly rather than clamping to
  zero; every payment is UNSAFE in that state and that is the correct answer.
- The function returns not just a verdict but a **reason object**: which term dominated, the
  numbers behind it, what the payment would leave you with, and **the runway it costs you**.
  A red badge with no explanation gets ignored within a week.
- Every threshold is a row in `rule_settings`, editable in the app. Rev 1 through 3 hardcoded
  guesses; the point of the settings page is that the owner never has to accept mine.
- Pure function in `lib/domain/safety.ts`. No DB access, no clock access. Inputs are a plain
  snapshot struct plus an explicit `now`.
- Property test: verdict is monotonic in `amount` — increasing the amount can never move the
  verdict from UNSAFE toward SAFE. This must continue to hold with an adaptive floor, where the
  floor itself no longer depends on the payment.

---

## 6. Dashboard

Above the fold, in priority order:

1. **Safe-to-spend today, per pool** — one card per currency you hold, each showing `available`
   in its own units, the terms that produced it, and the runway in days. The HKD card leads
   because that is where you live; USD and THB follow.
2. **Net worth** — three figures, one per pool, with `≈ HK$X at today's rate` as an explicitly
   secondary line. The estimate is never the headline: it moves when the market moves, and a
   net worth that changes because of a rate you did not act on is noise presented as news.
   Until P4 ships, investments are excluded and the card **says so** — a net-worth number that
   quietly omits your portfolio is worse than one that admits the gap.
3. **This month** — spent vs discretionary budget as a bar; income received; allocation
   compliance (did you actually move the 30%?).
4. **Upcoming** — scheduled outflows in the next 30 days, the same set `committed` uses.
   Consistency between the number and the list is what makes the number believable.
5. **Holdings** — quantity, avg cost, last close (with an `as of` date), unrealised P/L in HKD.
   A `LEGACY` chip on imported positions and a `COST UNKNOWN` chip where basis is missing.
   Portfolio P/L totals exclude unknown-cost positions and label the exclusion.
6. **Needs review** — `pending` transactions awaiting confirmation: tap stubs (if §7.2 ships)
   and scheduled items the reconciler couldn't match confidently. Empty is the normal state.
7. **Data health** — FX rate age, and the oldest stale equity price. Small, but it is what stops
   the five numbers above from quietly drifting toward confident nonsense. Every other item on
   this page degrades silently; this one degrades loudly.

Charts: spending by category (month), net worth over time, allocation actual vs target.
Recharts, in client components. No live-refresh polling — data changes a handful of times a day.

---

## 7. Capture — what is actually possible, and what we chose not to build

### 7.0 The decision

The brief asked for auto-add via email or Apple Wallet. Rev 1 and rev 2 chased that. Rev 3
stops chasing it, on the owner's instruction, and the reasoning holds up independently:

- **Apple Wallet has no general transaction-read API.** `FinanceKit` covers Apple Card / Cash /
  Savings in the US and certain open-banking institutions in the UK, requires a per-bundle-ID
  entitlement, and requires App Store distribution in the Finance category. For a Hong Kong
  personal web app this path is closed. It is not a matter of effort.
- **Four of your five institutions never send per-transaction email** (table below), so an email
  pipeline would serve one account while carrying the full cost of parsers, golden fixtures,
  confidence scoring, and a review queue.
- **Import formats are unverified and possibly PDF-only**, which was the single largest
  uncertainty in the estimate.

So the honest v1 is: **type it in.** Roughly 10–15 seconds per transaction with a good sheet,
against 6–10 days of build for a pipeline that would still miss most of your spending. For a
one-user tool that trade is not close.

What that buys back: no parser modules, no fixtures, no `inbox_items`, no confidence
thresholds, no per-institution breakage when a bank changes a template. §10 shrinks with it.

### 7.1 The institution reality

| Institution | Per-transaction email? | Apple Pay | v1 channel |
|---|---|---|---|
| **HSBC HK** | Yes (alerts configurable) | Yes | Manual (+ tap, if the spike passes) |
| **ZA Bank** | No — push-first | Yes | Manual (+ tap) |
| **Mox** | No — push-first | Yes | Manual (+ tap) |
| **Octopus** | No | Wallet (Express Transit) | Manual; tap **unconfirmed** |
| **PayMe** | No | n/a | Manual |

**One of five sends usable per-transaction email**, which is what made the email backbone a bad
bet for this account set regardless of the domain problem.

### 7.2 Apple Pay tap automation — the one automatic channel worth keeping

Recommended, because it needs **no parser and no fixtures** — a Shortcut POSTs a small JSON
body to one endpoint. It is the only automatic capture that survives the rev 3 simplicity bar.
Still optional: confirm at the P2 checkpoint.

Rev 1 asserted the Shortcuts Transaction trigger "carries no merchant or amount". **That claim
is contested.** Apple's own documentation describes only the card-selection option, but
credible third-party coverage of the trigger describes a *Receive Transaction As Input* option
exposing card/pass, merchant and amount, plus filtering by merchant and category. That coverage
dates from the iOS 17 beta period and there are scattered reports of the trigger misbehaving in
later releases, so treat it as **unresolved, and resolvable in fifteen minutes**:

> **P0 spike.** Build a two-action automation — Transaction trigger → show/append the input —
> tap a card, and read what actually arrives on your current iOS version.

Design so that either answer works:

- **Rich payload available** → post `{card, merchant, amount, tapped_at}` → a `pending`
  transaction you confirm with one tap. Near-complete passive capture of card spending, zero
  typing. Worth fifteen minutes to find out.
- **Tap-only payload** → have the Shortcut prompt for the amount at tap time. ~3 seconds of
  friction, near-100% capture, and still no parser. If prompting annoys you, drop the channel
  and lose nothing but convenience.

Octopus in Wallet is a separate question — Express Transit taps bypass authentication, so
whether the trigger fires at all is unknown. Same spike, second test.

*(An iOS 27 Shortcuts trigger that runs an automation when a chosen app posts a notification has
been reported in beta. For four push-first institutions that would be transformative — but it is
unconfirmed and must not be on the critical path. Track it; do not plan on it.)*

### 7.3 FX rates — free, automatic, overridable

The one automatic data feed that survives, because it costs nothing and manual FX entry would be
genuinely tedious across three currencies.

**Frankfurter (ECB reference rates)** — free, no API key, no account. Daily rates for HKD, THB
and USD, all derivable from the ECB's EUR-based set. A daily job writes `fx_rates`; the app
reads the rate for the transaction's date and freezes it on the entry (D2).

Two guardrails: ECB publishes on business days only, so a weekend transaction uses the last
published rate and records which date it came from. And **every rate is manually overridable** —
if you moved THB at a rate materially different from the reference, yours is the truth.

Equity prices remain manual (§13) with a staleness marker after 7 trading days.

### 7.4 The reconciler — one module, one job now

Rev 2 needed this for three cases. With import cut, two remain, and one of them is the
consequential one:

`recurrences` materialise `scheduled` transactions 60 days ahead so the safety rule can see
them. When the real payment is entered, `committed` **and** monthly spending both count it —
a silent, compounding error in the number the whole app is built around.

`lib/domain/reconcile.ts`, one match function scoring account, amount (within tolerance), time
window, and merchant similarity:

| Case | Window | Outcome |
|---|---|---|
| **scheduled ↔ posted** | ±7 days, same account & payee | scheduled row voided, `reconciled_with_id` set |
| tap-stub ↔ manual entry | ±90 min, same card | merge; stub's `reconciled_with_id` set (only if §7.2 ships) |

Above the match threshold it auto-merges; below, it proposes rather than guessing. This module
ships in P2 with the safety engine, because the scheduled↔posted case is a safety-rule bug, not
an ingest feature.

---

## 8. The 2000 HKD inflow rule

The brief: *"investment notice every time money enter more than 2000 HKD, 30% for savings."*
Three ambiguities, resolved:

**Per-inflow, not cumulative.** Each individual inflow ≥ threshold fires once. Cumulative would
fire on your 40th coffee refund and mean nothing.

**External inflows only.** Trigger requires a credit entry to an `is_own` account whose
counterparty entry is *not* an `is_own` account. Moving your own money between your own accounts
is not income. This is exactly what double-entry (D1) buys.

**Converted at posting-date FX**, using the frozen `fx_rate_to_hkd` on the entry.

```
ON transaction posted:
  IF is_external_inflow(txn) AND inflow_hkd_minor >= settings.threshold_hkd_minor:
     INSERT allocation_suggestions (trigger_transaction_id = txn.id, ...)
       ON CONFLICT (trigger_transaction_id) DO NOTHING     ← idempotent by construction
     suggested = round_half_even(inflow_hkd_minor * settings.allocation_pct)
     notify()
```

Defaults: `threshold_hkd_minor = 200000` (2,000 HKD), `allocation_pct = 0.30`, evaluated as a
**single sleeve** (§13 leaves the savings/investing split open; the engine supports a split, the
default does not use one). Both live in `rule_settings`, versioned by `effective_from` — so
changing the rule does not rewrite the history of decisions you already made under the old one.

**Evaluated once, at first posting.** If you later edit the amount of a transaction that already
fired, the suggestion is *not* recomputed and *not* re-fired — the `UNIQUE` constraint makes
that structural rather than a rule someone has to remember. Editing an inflow from 1,900 to
2,100 does not retroactively generate advice you never received. A `void` + re-entry does, which
is the correct escape hatch.

**Acting on a suggestion** creates a real transfer transaction to the designated savings or
brokerage account, in `scheduled` status until you confirm it executed. Dismiss requires a
reason (`dismiss_reason`), and the dashboard tracks your accept rate. A suggestion you never act
on is worse than no suggestion — the accept rate is how you find that out.

Rounding: banker's rounding on minor units. The suggestion is capped at liquid balance at
creation time and frozen, so it never suggests moving money already spent and never changes
value while you look at it.

---

## 9. Build phases

Each phase ends with something usable. Sizing is focused solo days — evenings and weekends, so
calendar time is 2–3× this.

| Phase | Deliverable | Done when | ~Days |
|---|---|---|---|
| **P0 — Foundation + first slice** | Next.js + TS + Supabase scaffold, Drizzle schema, RLS policies, PGlite test harness, CI. **Plus a real vertical slice**: create an account, enter a transaction, see the balance | Slice works end to end; migration up/down clean; RLS tests prove a second user reads nothing | 3–4 |
| **P1 — Ledger + dashboard** | Accounts, categories, `+` flows (spending / income / transfer) with **multi-currency HKD·THB·USD**, duplicate-then-edit, balance engine, FX job, dashboard 1–4, **data export (JSON + CSV)** | You can enter a week of real spending across all three currencies and the numbers tie out | 5–7 |
| **P2 — Safety engine** | `safety.ts` + `clock.ts` + `reconcile.ts`, live verdict in the `+` sheet, safe-to-spend card, `recurrences` + 60-day materialisation | Property + unit tests pass; verdict explains itself; scheduled↔posted counts once | 4–5 |
| **P3 — Allocation** | Allocation rule engine, suggestion UI, accept/dismiss with reason, accept-rate tracking | A ≥2,000 HKD inflow produces exactly one suggestion; re-entering it produces zero more | 2–3 |
| **P4 — Investments** | Instruments, holdings read model, legacy import with optional cost, manual price entry, holdings table with honest P/L | Real positions are in; unknown-cost positions are visibly excluded from P/L | 4–6 |
| **P5 — Tap capture** *(optional)* | Shortcuts endpoint, tap-stub or rich-payload flow per the spike, *Needs review* UI | You tap to pay and it appears without typing. **Skip entirely if the spike disappoints** | 2–3 |
| **P6 — Hardening** | Backups + rehearsed restore, error tracking, `security-reviewer` pass, perf pass, docs | Restore-from-backup rehearsed once, end to end | 3–4 |
|  |  | **Total** | **23–32** |

**Sequencing notes.**

- P0 ships a working slice, not just scaffolding — otherwise it violates the plan's own "every
  phase ends with something usable" rule on the very first line.
- **The old P4 is gone** (rev 3). That is 6–10 days and the single largest source of estimate
  variance, removed. It is also why P1 grew: multi-currency manual entry now carries the load
  that import was going to share.
- **Allocation moved up to P3.** Rev 2 put it after ingest because the rule is only interesting
  once inflows arrive automatically. With no automatic ingest, that reasoning is void — and the
  rule is one of the two things you actually asked for, so it should not sit at position five.
- **Investments before tap capture.** P4 delivers a number you can't get any other way; P5
  delivers convenience on a channel that may not even work.
- **P5 is genuinely optional** and gated on a spike you can run in fifteen minutes. If the
  Transaction trigger gives tap-only payloads and prompting annoys you, cut it and the plan
  finishes at 21–29 days with nothing of substance lost.

---

## 10. Testing

- **Domain rules — non-negotiable.** `safety.ts`, `allocation.ts`, `money.ts`, `fx.ts`,
  `clock.ts`, `balances.ts`, `reconcile.ts`, `holdings.ts` at 100% branch coverage. These are
  pure functions; there is no excuse.
- **Property tests** (fast-check): ledger entries always sum to zero *including the FX residual
  entry*; safety verdict monotonic in amount; minor-unit round-trip lossless; allocation never
  exceeds the inflow; **reconciliation is idempotent and never merges two posted transactions**.
- **Timezone tests.** A transaction at 23:30 HKT on the last day of the month lands in that
  month, not the next. A 00:30 HKT transaction on the 1st does not land in the previous. This
  test exists because the bug it catches is invisible until you reconcile a month.
- **FX residual tests — now a priority, not a formality.** With HKD, THB and USD all live, the
  three-currency case is a real path, not a hypothetical. Assert transactions balance to zero,
  and that a residual above one minor unit per leg raises rather than absorbs.
- **Double-count regression**: materialise a scheduled bill, post the matching payment, assert
  `committed` and monthly spend each count it once. This is the most consequential silent bug
  in the design; it gets a permanent test.
- **Idempotency tests**: re-posting the same inflow 3× → exactly one suggestion.
- **RLS tests**: a second user's token can read nothing, on every table.
- **E2E** (Playwright): add spending → dashboard updates; add a THB expense from an HKD account
  → FX frozen and balances correct; ≥2,000 inflow → suggestion appears → accept → transfer
  created.

Rev 3 removed the parser golden-file suite and the ingest replay tests along with the pipeline
they covered. That is a real reduction in test surface, and it is fine — but it means **manual
entry is now the only path into the ledger, so its E2E coverage is load-bearing.**

CI blocks merge on: typecheck, lint, unit, migration-up-down, and a `gitleaks` secret scan.

---

## 11. Security

Personal finance data, so:

- Supabase Auth, RLS enforced on every table, service-role key **server-only** and never in a
  `NEXT_PUBLIC_` var.
- **Public signup disabled.** One user, seeded. An open signup endpoint on a single-user finance
  app is pure downside.
- **Rev 3 shrank the attack surface considerably.** With import and email parsing cut, there is
  no untrusted-content path into the ledger at all — everything is typed by an authenticated
  user. The remaining external inputs are the FX feed (read-only, a known host, values
  range-checked) and, if P5 ships, the Shortcuts endpoint.
- Shortcuts endpoint (P5 only): rotatable bearer token, constant-time compare, timestamp window
  to block replay, rate-limited. Treat the token as compromised-by-default — it lives in a
  Shortcut on a phone. Rotation must be a one-minute operation or it will never happen.
- FX values are validated before they are written: positive, finite, and within a sane band of
  the previous rate. A feed returning garbage should fail the job, not silently reprice your
  net worth.
- No card numbers, no bank credentials, ever. The system records what you tell it about money;
  it never touches money.
- Run ECC's `security-reviewer` agent before each phase merges, and `gitleaks` in CI.

---

## 12. Working with ECC

ECC is installed at project scope in `.claude/` (`developer` profile). Suggested mapping:

| Work | ECC surface |
|---|---|
| Phase planning | `planner`, `architect` agents; `plan-canvas` skill |
| Schema + migrations | `database-reviewer` agent; `postgres-patterns`, `database-migrations` skills |
| Domain rules | `tdd-guide` agent; `tdd-workflow` skill — write the failing test first; these are the functions where it pays |
| React/Next work | `react-reviewer`, `typescript-reviewer`; `react-patterns` skills |
| Ingest endpoints | `api-design` skill; `security-reviewer` agent |
| Pre-merge | `code-reviewer`, `silent-failure-hunter` — the latter matters here; a swallowed parse error is a wrong balance |

Note: `.claude/hooks/hooks.json` is installed but **not wired into `.claude/settings.json`**.
Hooks are therefore inactive. Enable them deliberately, after reading them — don't enable a hook
set you haven't read.

---

## 13. Answers of record, and what is still open

**Answered 2026-08-11** — these drove rev 2 and should not be re-opened without re-costing the
phases they touch:

| Question | Answer | Consequence |
|---|---|---|
| Which institutions? | HSBC, ZA Bank, Mox, Octopus, PayMe | §7.1; only HSBC has a usable email channel |
| Domain for Cloudflare Email Routing? | No | Cloudflare Worker dropped |
| Market data? | Free FX + manual equity prices | Frankfurter/ECB (§7.3); no paid provider |
| Credit-card modelling? | Keep it simple | No cycle fields; full balance committed (§5) |
| Apple Pay usage? | Mostly Apple Pay | Tap capture kept as optional P5, gated on a spike |
| Legacy cost basis? | Only for some | `avg_cost` nullable; `COST UNKNOWN` chip; P/L excludes |
| **Currencies?** | **HKD, USD, THB** | FX live from day one; three-currency tests are priority |
| **Where do the foreign currencies live?** | ZA Bank (HKD + USD), KTB (THB) | Three pools; no CNY, so the currency set is unchanged |
| **Blend to HKD?** | **No** — "no need to make all to HKD" | Rev 4: HKD is the accounting unit only; reporting and safety are per pool |
| **Floor definition?** | Days of cover, not a fixed amount | `floor = floor_days × daily_burn`, self-calibrating |
| **Typical monthly spend?** | Under HK$8,000 | Seeds `daily_burn` until 30 days of history exist |
| **Discretionary budget?** | Owner sets an exact amount | Hence the settings page; the default is conservative and clearly labelled a placeholder |
| **Import pipeline?** | **"no need… keep it clean and easy"** | CSV/statement/PDF import cut; parsers, fixtures and `inbox_items` cut with it; old P4 gone |
| Dev database? | PGlite for tests, cloud Supabase for the app | No Docker; migration + RLS tests run in-process |
| Octopus / PayMe? | Real accounts with balances | Top-ups are own-account transfers; taps are spending |

**Still open:**

1. **The exact discretionary budget.** Owner will set it in the app. Until then the default is
   a placeholder and is labelled as one.
2. **Do USD and THB want floors?** Neither has one by default — USD reads as savings and THB as
   travel money. If either becomes money you live on, set `floor_days` for that pool.
3. **Savings vs investing split.** The brief says "30% for savings" under an "investment
   notice". Currently building a single 30% sleeve. If you want 10% cash / 20% invested, say so
   before P3; the engine supports it, the default doesn't use it.
4. **What do you actually hold?** Sizes P4 and determines whether manual price entry is a
   two-minute monthly chore or a real burden.
5. **Email parsing — keep or cut?** Standing recommendation: cut (§7.0).

---

## 14. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Manual entry doesn't stick as a habit** | **High — the defining risk of rev 3** | Fatal | Entry speed is now a primary feature (D5), not a fallback. If a transaction takes more than ~15s the tracker dies quietly. Budget real UI effort here and measure it |
| Manual prices go stale, P/L quietly misleads | High | Medium | Staleness marker on any price >7 trading days old; never render a stale number bare |
| FX job dies silently | Medium | Medium | `ingest_sources` heartbeat + data-health chip (§6.7); manual override always available |
| Transaction trigger gives tap-only, not amount/merchant | Medium | Low | P5 is optional; design handles both (§7.2) |
| Solo project stalls mid-build | High | High | Every phase ships something usable; P1 alone is a working tracker. Data export in P1 means nothing is trapped if you stop |

Rev 3 traded a build risk (a 6–10 day pipeline that might have parsed badly) for a **behavioural
risk** (you not typing things in). That is very likely the right trade for a personal tool — but
it is a real trade, not a free simplification, and the top row is where it gets paid.

That last row is not filler. The most likely failure mode for this project is not a technical
one — it is a half-built ledger abandoned at P4 with three months of partial data in it. The
phase ordering, the P1 export, and the "every phase is usable" rule all exist to make stopping
early survivable.

---

## Sources

- [Transaction triggers in Shortcuts — Apple Support](https://support.apple.com/guide/shortcuts/transaction-trigger-apd65c67538a/ios) · [Transaction automation detail — Matthew Cassinelli](https://matthewcassinelli.com/shortcuts-automations-ios-ipados-transaction-display-stage-manager/) *(contested; see §7.2)*
- [FinanceKit — Apple Developer](https://developer.apple.com/documentation/FinanceKit) — US/UK only, App Store Finance category required; closed for a HK personal web app
- [Installable Triggers — Apps Script](https://developers.google.com/apps-script/guides/triggers/installable) · [Simple Triggers](https://developers.google.com/apps-script/guides/triggers) *(simple triggers cannot call `UrlFetchApp`)* · [Authorization for Google Services](https://developers.google.com/apps-script/guides/services/authorization) · [Apps Script quotas](https://appscriptexpert.com/blog/google-apps-script-quotas-and-limits)
- [Restricted scope verification — Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) · [CASA Security Assessment](https://support.google.com/cloud/answer/13465431) · [Unverified apps](https://support.google.com/cloud/answer/7454865)
