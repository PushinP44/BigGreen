CREATE TYPE "public"."account_kind" AS ENUM('cash', 'bank', 'credit_card', 'ewallet', 'brokerage', 'equity', 'expense', 'income');--> statement-breakpoint
CREATE TYPE "public"."instrument_kind" AS ENUM('stock', 'etf', 'index_fund', 'mutual_fund');--> statement-breakpoint
CREATE TYPE "public"."suggestion_state" AS ENUM('pending', 'accepted', 'dismissed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('manual', 'shortcut', 'recurrence');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('scheduled', 'pending', 'posted', 'void');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "account_kind" NOT NULL,
	"institution" text,
	"currency" char(3) NOT NULL,
	"is_liquid" boolean DEFAULT false NOT NULL,
	"is_own" boolean DEFAULT false NOT NULL,
	"opening_balance_minor" bigint DEFAULT 0 NOT NULL,
	"system_role" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_currency_check" CHECK (currency in ('HKD', 'THB', 'USD')),
	CONSTRAINT "accounts_liquid_implies_own" CHECK (not "accounts"."is_liquid" or "accounts"."is_own")
);
--> statement-breakpoint
CREATE TABLE "allocation_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger_transaction_id" uuid NOT NULL,
	"inflow_hkd_minor" bigint NOT NULL,
	"suggested_hkd_minor" bigint NOT NULL,
	"rule_version" text NOT NULL,
	"state" "suggestion_state" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"dismiss_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_suggestions_trigger_transaction_id_unique" UNIQUE("trigger_transaction_id"),
	CONSTRAINT "allocation_within_inflow" CHECK ("allocation_suggestions"."suggested_hkd_minor" >= 0 and "allocation_suggestions"."suggested_hkd_minor" <= "allocation_suggestions"."inflow_hkd_minor")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"is_discretionary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"fx_rate_to_hkd" numeric(18, 8) NOT NULL,
	"amount_hkd_minor" bigint NOT NULL,
	"is_fx_residual" boolean DEFAULT false NOT NULL,
	"instrument_id" uuid,
	"quantity_delta" numeric(28, 10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_currency_check" CHECK (currency in ('HKD', 'THB', 'USD')),
	CONSTRAINT "entries_fx_rate_positive" CHECK ("entries"."fx_rate_to_hkd" > 0),
	CONSTRAINT "entries_instrument_quantity_together" CHECK (("entries"."instrument_id" is null) = ("entries"."quantity_delta" is null))
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"user_id" uuid NOT NULL,
	"base" char(3) NOT NULL,
	"quote" char(3) NOT NULL,
	"as_of" date NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"source" text DEFAULT 'frankfurter' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_user_id_base_quote_as_of_pk" PRIMARY KEY("user_id","base","quote","as_of"),
	CONSTRAINT "fx_rates_positive" CHECK ("fx_rates"."rate" > 0),
	CONSTRAINT "fx_rates_distinct" CHECK ("fx_rates"."base" <> "fx_rates"."quote")
);
--> statement-breakpoint
CREATE TABLE "ingest_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"expected_interval_minutes" integer DEFAULT 1440 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"isin" text,
	"kind" "instrument_kind" NOT NULL,
	"currency" char(3) NOT NULL,
	"exchange" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_currency_check" CHECK (currency in ('HKD', 'THB', 'USD'))
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"user_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"close_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prices_user_id_instrument_id_as_of_pk" PRIMARY KEY("user_id","instrument_id","as_of"),
	CONSTRAINT "prices_currency_check" CHECK (currency in ('HKD', 'THB', 'USD')),
	CONSTRAINT "prices_close_non_negative" CHECK ("prices"."close_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_transaction_id" uuid NOT NULL,
	"rrule" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_json" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"booked_at" timestamp with time zone,
	"status" "transaction_status" DEFAULT 'posted' NOT NULL,
	"description" text,
	"merchant" text,
	"category_id" uuid,
	"source" "transaction_source" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"notes" text,
	"reconciled_with_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocation_suggestions" ADD CONSTRAINT "allocation_suggestions_trigger_transaction_id_transactions_id_fk" FOREIGN KEY ("trigger_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrences" ADD CONSTRAINT "recurrences_template_transaction_id_transactions_id_fk" FOREIGN KEY ("template_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_system_role_idx" ON "accounts" USING btree ("user_id","system_role") WHERE system_role is not null;--> statement-breakpoint
CREATE INDEX "allocation_state_idx" ON "allocation_suggestions" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "categories_user_idx" ON "categories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "entries_transaction_idx" ON "entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "entries_account_idx" ON "entries" USING btree ("user_id","account_id");--> statement-breakpoint
CREATE INDEX "entries_instrument_idx" ON "entries" USING btree ("user_id","instrument_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_sources_key_idx" ON "ingest_sources" USING btree ("user_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_user_symbol_idx" ON "instruments" USING btree ("user_id","symbol");--> statement-breakpoint
CREATE INDEX "recurrences_due_idx" ON "recurrences" USING btree ("user_id","active","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rule_settings_key_from_idx" ON "rule_settings" USING btree ("user_id","key","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_source_external_idx" ON "transactions" USING btree ("user_id","source","external_id") WHERE external_id is not null;--> statement-breakpoint
CREATE INDEX "transactions_user_occurred_idx" ON "transactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("user_id","status");