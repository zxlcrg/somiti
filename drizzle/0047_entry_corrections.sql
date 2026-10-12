CREATE TYPE "public"."correction_kind" AS ENUM('savings_deposit', 'savings_withdrawal', 'share_purchase', 'loan_repayment');--> statement-breakpoint
CREATE TABLE "entry_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"kind" "correction_kind" NOT NULL,
	"status" "voucher_status" DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_on" date NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"reversal_id" uuid,
	"submit_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_correction_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "entry_correction_submit_key" UNIQUE("tenant_id","submit_key"),
	CONSTRAINT "entry_correction_reason" CHECK (length(trim("entry_correction"."reason")) BETWEEN 3 AND 300),
	CONSTRAINT "entry_correction_checker_not_maker" CHECK ("entry_correction"."decided_by" IS NULL OR "entry_correction"."status" = 'cancelled' OR "entry_correction"."decided_by" <> "entry_correction"."requested_by"),
	CONSTRAINT "entry_correction_decided" CHECK (("entry_correction"."status" = 'pending') = ("entry_correction"."decided_by" IS NULL) AND ("entry_correction"."decided_by" IS NULL) = ("entry_correction"."decided_at" IS NULL)),
	CONSTRAINT "entry_correction_posted" CHECK (("entry_correction"."status" = 'approved') = ("entry_correction"."reversal_id" IS NOT NULL)),
	CONSTRAINT "entry_correction_reject_note" CHECK ("entry_correction"."status" <> 'rejected' OR length(trim(coalesce("entry_correction"."decision_note", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "entry_correction" ADD CONSTRAINT "entry_correction_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_correction" ADD CONSTRAINT "entry_correction_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_correction" ADD CONSTRAINT "entry_correction_reversal_fk" FOREIGN KEY ("tenant_id","reversal_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_correction" ADD CONSTRAINT "entry_correction_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_correction" ADD CONSTRAINT "entry_correction_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_correction_entry_idx" ON "entry_correction" USING btree ("tenant_id","entry_id");