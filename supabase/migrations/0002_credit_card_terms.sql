ALTER TABLE "accounts" ADD COLUMN "credit_limit_minor" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "statement_day" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "payment_due_day" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "apr_bps" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "min_payment_pct_bps" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "min_payment_floor_minor" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_statement_day_range" CHECK ("accounts"."statement_day" is null or ("accounts"."statement_day" between 1 and 31));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_due_day_range" CHECK ("accounts"."payment_due_day" is null or ("accounts"."payment_due_day" between 1 and 31));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_apr_non_negative" CHECK ("accounts"."apr_bps" is null or "accounts"."apr_bps" >= 0);