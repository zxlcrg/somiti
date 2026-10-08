CREATE TYPE "public"."loan_allocation" AS ENUM('interest_first', 'principal_first');--> statement-breakpoint
ALTER TYPE "public"."entry_source" ADD VALUE 'loan_repayment' BEFORE 'reversal';--> statement-breakpoint
ALTER TYPE "public"."sms_kind" ADD VALUE 'loan_repayment';--> statement-breakpoint
CREATE TABLE "loan_repayment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"principal" bigint NOT NULL,
	"interest" bigint NOT NULL,
	"channel" "deposit_channel" NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_ref" text,
	"journal_entry_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_repayment_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_repayment_entry" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "loan_repayment_amounts" CHECK ("loan_repayment"."amount" > 0 AND "loan_repayment"."principal" >= 0 AND "loan_repayment"."interest" >= 0 AND "loan_repayment"."amount" = "loan_repayment"."principal" + "loan_repayment"."interest"),
	CONSTRAINT "loan_repayment_collector_cash" CHECK ("loan_repayment"."channel" = 'office' OR "loan_repayment"."payment_method" = 'cash')
);
--> statement-breakpoint
CREATE TABLE "loan_repayment_line" (
	"tenant_id" uuid NOT NULL,
	"repayment_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"principal" bigint NOT NULL,
	"interest" bigint NOT NULL,
	CONSTRAINT "loan_repayment_line_seq" UNIQUE("tenant_id","repayment_id","seq"),
	CONSTRAINT "loan_repayment_line_amounts" CHECK ("loan_repayment_line"."principal" >= 0 AND "loan_repayment_line"."interest" >= 0 AND "loan_repayment_line"."principal" + "loan_repayment_line"."interest" > 0)
);
--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "allocation" "loan_allocation" DEFAULT 'interest_first' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "closed_on" date;--> statement-breakpoint
ALTER TABLE "loan_product" ADD COLUMN "allocation" "loan_allocation" DEFAULT 'interest_first' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD CONSTRAINT "loan_repayment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD CONSTRAINT "loan_repayment_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loan"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD CONSTRAINT "loan_repayment_entry_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD CONSTRAINT "loan_repayment_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_repayment_line" ADD CONSTRAINT "loan_repayment_line_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_repayment_line" ADD CONSTRAINT "loan_repayment_line_repayment_fk" FOREIGN KEY ("tenant_id","repayment_id") REFERENCES "public"."loan_repayment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_repayment_line" ADD CONSTRAINT "loan_repayment_line_installment_fk" FOREIGN KEY ("tenant_id","loan_id","seq") REFERENCES "public"."loan_installment"("tenant_id","loan_id","seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_repayment_loan" ON "loan_repayment" USING btree ("tenant_id","loan_id","created_at");--> statement-breakpoint
CREATE INDEX "loan_repayment_collector" ON "loan_repayment" USING btree ("tenant_id","created_by","business_date");--> statement-breakpoint
CREATE INDEX "loan_repayment_line_installment" ON "loan_repayment_line" USING btree ("tenant_id","loan_id","seq");--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_closed" CHECK (("loan"."status" = 'closed') = ("loan"."closed_on" IS NOT NULL));