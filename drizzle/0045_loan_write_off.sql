CREATE TYPE "public"."write_off_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."entry_source" ADD VALUE 'loan_write_off' BEFORE 'reversal';--> statement-breakpoint
ALTER TYPE "public"."loan_status" ADD VALUE 'written_off';--> statement-breakpoint
CREATE TABLE "loan_write_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"status" "write_off_status" DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_on" date NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"principal" bigint,
	"charge" bigint,
	"entry_id" uuid,
	"submit_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_write_off_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_write_off_submit_key" UNIQUE("tenant_id","submit_key"),
	CONSTRAINT "loan_write_off_reason" CHECK (length(trim("loan_write_off"."reason")) BETWEEN 3 AND 300),
	CONSTRAINT "loan_write_off_checker_not_maker" CHECK ("loan_write_off"."decided_by" IS NULL OR "loan_write_off"."status" = 'cancelled' OR "loan_write_off"."decided_by" <> "loan_write_off"."requested_by"),
	CONSTRAINT "loan_write_off_decided" CHECK (("loan_write_off"."status" = 'pending') = ("loan_write_off"."decided_by" IS NULL) AND ("loan_write_off"."decided_by" IS NULL) = ("loan_write_off"."decided_at" IS NULL)),
	CONSTRAINT "loan_write_off_posted" CHECK (("loan_write_off"."status" = 'approved') = ("loan_write_off"."entry_id" IS NOT NULL)
          AND ("loan_write_off"."entry_id" IS NULL) = ("loan_write_off"."principal" IS NULL)
          AND ("loan_write_off"."entry_id" IS NULL) = ("loan_write_off"."charge" IS NULL)
          AND ("loan_write_off"."principal" IS NULL OR ("loan_write_off"."principal" > 0 AND "loan_write_off"."charge" >= 0))),
	CONSTRAINT "loan_write_off_reject_note" CHECK ("loan_write_off"."status" <> 'rejected' OR length(trim(coalesce("loan_write_off"."decision_note", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "loan" DROP CONSTRAINT "loan_checker_not_maker";--> statement-breakpoint
ALTER TABLE "loan" DROP CONSTRAINT "loan_disbursed";--> statement-breakpoint
ALTER TABLE "loan_write_off" ADD CONSTRAINT "loan_write_off_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_write_off" ADD CONSTRAINT "loan_write_off_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loan"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_write_off" ADD CONSTRAINT "loan_write_off_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_write_off" ADD CONSTRAINT "loan_write_off_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_write_off" ADD CONSTRAINT "loan_write_off_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_write_off_loan_idx" ON "loan_write_off" USING btree ("tenant_id","loan_id");--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_checker_not_maker" CHECK ("loan"."imported_on" IS NOT NULL OR "loan"."status"::text NOT IN ('approved', 'rejected', 'disbursed', 'closed', 'written_off') OR "loan"."decided_by" <> "loan"."applied_by");--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_disbursed" CHECK (("loan"."status"::text IN ('disbursed', 'closed', 'written_off')) = ("loan"."entry_id" IS NOT NULL)
          AND ("loan"."entry_id" IS NULL) = ("loan"."disbursed_on" IS NULL)
          AND ("loan"."entry_id" IS NULL) = ("loan"."disbursed_by" IS NULL)
          AND ("loan"."imported_on" IS NOT NULL OR ("loan"."entry_id" IS NULL) = ("loan"."payment_method" IS NULL)));