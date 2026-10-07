CREATE TYPE "public"."exit_payout_kind" AS ENUM('shares', 'savings');--> statement-breakpoint
ALTER TYPE "public"."entry_source" ADD VALUE 'member_exit' BEFORE 'day_close';--> statement-breakpoint
ALTER TYPE "public"."share_txn_kind" ADD VALUE 'refund';--> statement-breakpoint
CREATE TABLE "member_exit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_ref" text,
	"status" "voucher_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submit_key" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"share_refund" bigint,
	"savings_payout" bigint,
	CONSTRAINT "member_exit_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "member_exit_submit_key" UNIQUE("tenant_id","submit_key"),
	CONSTRAINT "member_exit_reason" CHECK (length(trim("member_exit"."reason")) > 0),
	CONSTRAINT "member_exit_wallet_ref" CHECK ("member_exit"."payment_method" <> 'mobile_wallet' OR length(trim("member_exit"."payment_ref")) > 0),
	CONSTRAINT "member_exit_decision_complete" CHECK (("member_exit"."status" = 'pending') = ("member_exit"."decided_by" IS NULL) AND ("member_exit"."decided_by" IS NULL) = ("member_exit"."decided_at" IS NULL)),
	CONSTRAINT "member_exit_approved_amounts" CHECK (("member_exit"."status" = 'approved') = ("member_exit"."share_refund" IS NOT NULL) AND ("member_exit"."share_refund" IS NULL) = ("member_exit"."savings_payout" IS NULL)),
	CONSTRAINT "member_exit_amounts_not_negative" CHECK (coalesce("member_exit"."share_refund", 0) >= 0 AND coalesce("member_exit"."savings_payout", 0) >= 0),
	CONSTRAINT "member_exit_rejected_has_note" CHECK ("member_exit"."status" <> 'rejected' OR length(trim(coalesce("member_exit"."decision_note", ''))) > 0),
	CONSTRAINT "member_exit_checker_not_maker" CHECK ("member_exit"."status" NOT IN ('approved', 'rejected') OR "member_exit"."decided_by" <> "member_exit"."requested_by"),
	CONSTRAINT "member_exit_cancelled_by_maker" CHECK ("member_exit"."status" <> 'cancelled' OR "member_exit"."decided_by" = "member_exit"."requested_by")
);
--> statement-breakpoint
CREATE TABLE "member_exit_payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"exit_id" uuid NOT NULL,
	"kind" "exit_payout_kind" NOT NULL,
	"savings_account_id" uuid,
	"amount" bigint NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	CONSTRAINT "member_exit_payout_entry" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "member_exit_payout_amount" CHECK ("member_exit_payout"."amount" > 0),
	CONSTRAINT "member_exit_payout_account" CHECK (("member_exit_payout"."kind" = 'savings') = ("member_exit_payout"."savings_account_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "share_transaction" DROP CONSTRAINT "share_transaction_amount";--> statement-breakpoint
ALTER TABLE "member_exit" ADD CONSTRAINT "member_exit_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_exit" ADD CONSTRAINT "member_exit_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_exit" ADD CONSTRAINT "member_exit_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_exit" ADD CONSTRAINT "member_exit_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_exit_payout" ADD CONSTRAINT "member_exit_payout_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_exit_payout" ADD CONSTRAINT "member_exit_payout_exit_fk" FOREIGN KEY ("tenant_id","exit_id") REFERENCES "public"."member_exit"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_exit_payout" ADD CONSTRAINT "member_exit_payout_account_fk" FOREIGN KEY ("tenant_id","savings_account_id") REFERENCES "public"."savings_account"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_exit_payout" ADD CONSTRAINT "member_exit_payout_entry_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_exit_one_pending" ON "member_exit" USING btree ("tenant_id","member_id") WHERE "member_exit"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "member_exit_status" ON "member_exit" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "member_exit_payout_exit" ON "member_exit_payout" USING btree ("tenant_id","exit_id");--> statement-breakpoint
ALTER TABLE "share_transaction" ADD CONSTRAINT "share_transaction_amount" CHECK ("share_transaction"."kind"::text = 'refund' OR "share_transaction"."amount" = "share_transaction"."shares"::bigint * "share_transaction"."price");