CREATE TYPE "public"."voucher_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "voucher" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"narration" text NOT NULL,
	"total" bigint NOT NULL,
	"status" "voucher_status" DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_txid" bigint DEFAULT txid_current() NOT NULL,
	"submit_key" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"entry_id" uuid,
	CONSTRAINT "voucher_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "voucher_tenant_submit_key" UNIQUE("tenant_id","submit_key"),
	CONSTRAINT "voucher_tenant_entry" UNIQUE("tenant_id","entry_id"),
	CONSTRAINT "voucher_total_positive" CHECK ("voucher"."total" > 0),
	CONSTRAINT "voucher_decision_complete" CHECK (("voucher"."status" = 'pending') = ("voucher"."decided_by" IS NULL) AND ("voucher"."decided_by" IS NULL) = ("voucher"."decided_at" IS NULL)),
	CONSTRAINT "voucher_approved_has_entry" CHECK (("voucher"."status" = 'approved') = ("voucher"."entry_id" IS NOT NULL)),
	CONSTRAINT "voucher_rejected_has_note" CHECK ("voucher"."status" <> 'rejected' OR length(trim(coalesce("voucher"."decision_note", ''))) > 0),
	CONSTRAINT "voucher_checker_not_maker" CHECK ("voucher"."status" NOT IN ('approved', 'rejected') OR "voucher"."decided_by" <> "voucher"."created_by"),
	CONSTRAINT "voucher_cancelled_by_maker" CHECK ("voucher"."status" <> 'cancelled' OR "voucher"."decided_by" = "voucher"."created_by")
);
--> statement-breakpoint
CREATE TABLE "voucher_line" (
	"tenant_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	CONSTRAINT "voucher_line_tenant_id_voucher_id_line_no_pk" PRIMARY KEY("tenant_id","voucher_id","line_no"),
	CONSTRAINT "voucher_line_one_side" CHECK ("voucher_line"."debit" >= 0 AND "voucher_line"."credit" >= 0 AND ("voucher_line"."debit" > 0) <> ("voucher_line"."credit" > 0))
);
--> statement-breakpoint
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_line" ADD CONSTRAINT "voucher_line_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_line" ADD CONSTRAINT "voucher_line_voucher_fk" FOREIGN KEY ("tenant_id","voucher_id") REFERENCES "public"."voucher"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_line" ADD CONSTRAINT "voucher_line_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_account"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_tenant_status_created" ON "voucher" USING btree ("tenant_id","status","created_at");