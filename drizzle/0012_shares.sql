CREATE TYPE "public"."payment_method" AS ENUM('cash', 'bank', 'mobile_wallet');--> statement-breakpoint
CREATE TYPE "public"."share_txn_kind" AS ENUM('purchase');--> statement-breakpoint
ALTER TYPE "public"."entry_source" ADD VALUE 'share_purchase' BEFORE 'reversal';--> statement-breakpoint
CREATE TABLE "share_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" "share_txn_kind" NOT NULL,
	"shares" integer NOT NULL,
	"price" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_ref" text,
	"journal_entry_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_transaction_entry" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "share_transaction_shares" CHECK ("share_transaction"."shares" BETWEEN 1 AND 100000),
	CONSTRAINT "share_transaction_price" CHECK ("share_transaction"."price" > 0),
	CONSTRAINT "share_transaction_amount" CHECK ("share_transaction"."amount" = "share_transaction"."shares"::bigint * "share_transaction"."price"),
	CONSTRAINT "share_transaction_wallet_ref" CHECK ("share_transaction"."payment_method" <> 'mobile_wallet' OR length(trim("share_transaction"."payment_ref")) > 0)
);
--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "share_price" bigint DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_transaction" ADD CONSTRAINT "share_transaction_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transaction" ADD CONSTRAINT "share_transaction_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transaction" ADD CONSTRAINT "share_transaction_entry_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transaction" ADD CONSTRAINT "share_transaction_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_transaction_member" ON "share_transaction" USING btree ("tenant_id","member_id");--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_share_price_positive" CHECK ("tenant"."share_price" > 0);