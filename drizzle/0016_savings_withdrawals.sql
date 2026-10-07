ALTER TYPE "public"."entry_source" ADD VALUE 'savings_withdrawal' BEFORE 'reversal';--> statement-breakpoint
ALTER TYPE "public"."savings_txn_kind" ADD VALUE 'withdrawal';--> statement-breakpoint
CREATE TABLE "savings_withdrawal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_ref" text,
	"reason" text,
	"status" "voucher_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submit_key" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"entry_id" uuid,
	CONSTRAINT "savings_withdrawal_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "savings_withdrawal_submit_key" UNIQUE("tenant_id","submit_key"),
	CONSTRAINT "savings_withdrawal_entry" UNIQUE("tenant_id","entry_id"),
	CONSTRAINT "savings_withdrawal_amount" CHECK ("savings_withdrawal"."amount" > 0),
	CONSTRAINT "savings_withdrawal_wallet_ref" CHECK ("savings_withdrawal"."payment_method" <> 'mobile_wallet' OR length(trim("savings_withdrawal"."payment_ref")) > 0),
	CONSTRAINT "savings_withdrawal_decision_complete" CHECK (("savings_withdrawal"."status" = 'pending') = ("savings_withdrawal"."decided_by" IS NULL) AND ("savings_withdrawal"."decided_by" IS NULL) = ("savings_withdrawal"."decided_at" IS NULL)),
	CONSTRAINT "savings_withdrawal_approved_has_entry" CHECK (("savings_withdrawal"."status" = 'approved') = ("savings_withdrawal"."entry_id" IS NOT NULL)),
	CONSTRAINT "savings_withdrawal_rejected_has_note" CHECK ("savings_withdrawal"."status" <> 'rejected' OR length(trim(coalesce("savings_withdrawal"."decision_note", ''))) > 0),
	CONSTRAINT "savings_withdrawal_checker_not_maker" CHECK ("savings_withdrawal"."status" NOT IN ('approved', 'rejected') OR "savings_withdrawal"."decided_by" <> "savings_withdrawal"."requested_by"),
	CONSTRAINT "savings_withdrawal_cancelled_by_maker" CHECK ("savings_withdrawal"."status" <> 'cancelled' OR "savings_withdrawal"."decided_by" = "savings_withdrawal"."requested_by")
);
--> statement-breakpoint
ALTER TABLE "savings_withdrawal" ADD CONSTRAINT "savings_withdrawal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_withdrawal" ADD CONSTRAINT "savings_withdrawal_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."savings_account"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_withdrawal" ADD CONSTRAINT "savings_withdrawal_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_withdrawal" ADD CONSTRAINT "savings_withdrawal_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_withdrawal" ADD CONSTRAINT "savings_withdrawal_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "savings_withdrawal_status" ON "savings_withdrawal" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "savings_withdrawal_account" ON "savings_withdrawal" USING btree ("tenant_id","account_id","created_at");