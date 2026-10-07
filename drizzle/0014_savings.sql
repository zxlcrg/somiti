CREATE TYPE "public"."deposit_channel" AS ENUM('office', 'collector');--> statement-breakpoint
CREATE TYPE "public"."savings_account_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."savings_frequency" AS ENUM('flexible', 'daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."savings_txn_kind" AS ENUM('deposit');--> statement-breakpoint
ALTER TYPE "public"."entry_source" ADD VALUE 'savings_deposit' BEFORE 'reversal';--> statement-breakpoint
CREATE TABLE "savings_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_no" integer NOT NULL,
	"member_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"installment" bigint,
	"opened_on" date NOT NULL,
	"status" "savings_account_status" DEFAULT 'active' NOT NULL,
	"opened_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_account_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "savings_account_no" UNIQUE("tenant_id","account_no"),
	CONSTRAINT "savings_account_no_positive" CHECK ("savings_account"."account_no" > 0),
	CONSTRAINT "savings_account_installment" CHECK ("savings_account"."installment" IS NULL OR "savings_account"."installment" > 0)
);
--> statement-breakpoint
CREATE TABLE "savings_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_bn" text,
	"frequency" "savings_frequency" NOT NULL,
	"installment" bigint,
	"min_deposit" bigint DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_product_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "savings_product_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "savings_product_code_format" CHECK ("savings_product"."code" ~ '^[A-Z0-9-]{1,12}$'),
	CONSTRAINT "savings_product_name" CHECK (length(trim("savings_product"."name_en")) BETWEEN 1 AND 80),
	CONSTRAINT "savings_product_installment" CHECK (("savings_product"."frequency" = 'flexible' AND "savings_product"."installment" IS NULL) OR ("savings_product"."frequency" <> 'flexible' AND "savings_product"."installment" > 0)),
	CONSTRAINT "savings_product_min_deposit" CHECK ("savings_product"."min_deposit" > 0)
);
--> statement-breakpoint
CREATE TABLE "savings_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "savings_txn_kind" NOT NULL,
	"amount" bigint NOT NULL,
	"channel" "deposit_channel" NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_ref" text,
	"journal_entry_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_transaction_entry" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "savings_transaction_amount" CHECK ("savings_transaction"."amount" > 0),
	CONSTRAINT "savings_transaction_wallet_ref" CHECK ("savings_transaction"."payment_method" <> 'mobile_wallet' OR length(trim("savings_transaction"."payment_ref")) > 0),
	CONSTRAINT "savings_transaction_collector_cash" CHECK ("savings_transaction"."channel" = 'office' OR "savings_transaction"."payment_method" = 'cash')
);
--> statement-breakpoint
ALTER TABLE "savings_account" ADD CONSTRAINT "savings_account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_account" ADD CONSTRAINT "savings_account_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_account" ADD CONSTRAINT "savings_account_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."savings_product"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_account" ADD CONSTRAINT "savings_account_opened_by_fk" FOREIGN KEY ("tenant_id","opened_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_product" ADD CONSTRAINT "savings_product_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_product" ADD CONSTRAINT "savings_product_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_transaction" ADD CONSTRAINT "savings_transaction_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_transaction" ADD CONSTRAINT "savings_transaction_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."savings_account"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_transaction" ADD CONSTRAINT "savings_transaction_entry_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_transaction" ADD CONSTRAINT "savings_transaction_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "savings_account_one_open" ON "savings_account" USING btree ("tenant_id","member_id","product_id") WHERE "savings_account"."status" = 'active';--> statement-breakpoint
CREATE INDEX "savings_account_member" ON "savings_account" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE INDEX "savings_transaction_account" ON "savings_transaction" USING btree ("tenant_id","account_id","created_at");--> statement-breakpoint
CREATE INDEX "savings_transaction_date" ON "savings_transaction" USING btree ("tenant_id","business_date");