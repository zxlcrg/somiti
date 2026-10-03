CREATE TYPE "public"."locale" AS ENUM('en', 'bn');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('admin', 'president', 'secretary', 'cashier', 'field_collector', 'member');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'income', 'expense');--> statement-breakpoint
CREATE TYPE "public"."entry_source" AS ENUM('opening_balance', 'manual_voucher', 'reversal', 'system');--> statement-breakpoint
CREATE TYPE "public"."period_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid,
	"name_en" text,
	"name_bn" text,
	"phone" text NOT NULL,
	"locale" "locale",
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "app_user_tenant_phone" UNIQUE("tenant_id","phone"),
	CONSTRAINT "app_user_has_name" CHECK ("app_user"."name_en" IS NOT NULL OR "app_user"."name_bn" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "branch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_en" text,
	"name_bn" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "branch_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "branch_has_name" CHECK ("branch"."name_en" IS NOT NULL OR "branch"."name_bn" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_key_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_en" text,
	"name_bn" text,
	"default_locale" "locale" DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'Asia/Dhaka' NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 7 NOT NULL,
	"business_date" date NOT NULL,
	"locked_through" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenant_has_name" CHECK ("tenant"."name_en" IS NOT NULL OR "tenant"."name_bn" IS NOT NULL),
	CONSTRAINT "tenant_fiscal_month" CHECK ("tenant"."fiscal_year_start_month" BETWEEN 1 AND 12),
	CONSTRAINT "tenant_business_date_after_lock" CHECK ("tenant"."locked_through" IS NULL OR "tenant"."business_date" > "tenant"."locked_through")
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "staff_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_tenant_id_user_id_role_pk" PRIMARY KEY("tenant_id","user_id","role")
);
--> statement-breakpoint
CREATE TABLE "entry_counter" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_no" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "period_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_period_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "fiscal_period_dates" CHECK ("fiscal_period"."end_date" >= "fiscal_period"."start_date")
);
--> statement-breakpoint
CREATE TABLE "journal_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"entry_no" bigint NOT NULL,
	"business_date" date NOT NULL,
	"source" "entry_source" NOT NULL,
	"narration" text NOT NULL,
	"reverses_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_txid" bigint DEFAULT txid_current() NOT NULL,
	CONSTRAINT "journal_entry_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "journal_entry_tenant_entry_no" UNIQUE("tenant_id","entry_no"),
	CONSTRAINT "journal_entry_reversal_source" CHECK (("journal_entry"."source" = 'reversal') = ("journal_entry"."reverses_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "journal_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"member_id" uuid,
	"savings_account_id" uuid,
	"loan_id" uuid,
	"memo" text,
	CONSTRAINT "journal_line_entry_line_no" UNIQUE("tenant_id","entry_id","line_no"),
	CONSTRAINT "journal_line_one_side" CHECK ("journal_line"."debit" >= 0 AND "journal_line"."credit" >= 0 AND ("journal_line"."debit" > 0) <> ("journal_line"."credit" > 0))
);
--> statement-breakpoint
CREATE TABLE "ledger_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_en" text,
	"name_bn" text,
	"type" "account_type" NOT NULL,
	"parent_id" uuid,
	"system_key" text,
	"is_postable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_account_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ledger_account_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ledger_account_tenant_system_key" UNIQUE("tenant_id","system_key"),
	CONSTRAINT "ledger_account_has_name" CHECK ("ledger_account"."name_en" IS NOT NULL OR "ledger_account"."name_bn" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"device" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_counter" ADD CONSTRAINT "entry_counter_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period" ADD CONSTRAINT "fiscal_period_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period" ADD CONSTRAINT "fiscal_period_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_reverses_fk" FOREIGN KEY ("tenant_id","reverses_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_account"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."ledger_account"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entry_tenant_business_date" ON "journal_entry" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entry_reverses_once" ON "journal_entry" USING btree ("tenant_id","reverses_id") WHERE "journal_entry"."reverses_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "journal_line_tenant_account" ON "journal_line" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_entity" ON "audit_log" USING btree ("tenant_id","entity_type","entity_id");