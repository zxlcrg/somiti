ALTER TYPE "public"."sms_kind" ADD VALUE 'loan_reschedule';--> statement-breakpoint
CREATE TABLE "loan_reschedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"no" integer NOT NULL,
	"business_date" date NOT NULL,
	"principal" bigint NOT NULL,
	"interest" bigint NOT NULL,
	"extra_charge" bigint DEFAULT 0 NOT NULL,
	"installments" integer NOT NULL,
	"first_due_on" date NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_reschedule_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_reschedule_no" UNIQUE("tenant_id","loan_id","no"),
	CONSTRAINT "loan_reschedule_no_positive" CHECK ("loan_reschedule"."no" > 0),
	CONSTRAINT "loan_reschedule_amounts" CHECK ("loan_reschedule"."principal" >= 0 AND "loan_reschedule"."interest" >= 0 AND "loan_reschedule"."extra_charge" >= 0 AND "loan_reschedule"."principal" + "loan_reschedule"."interest" > 0),
	CONSTRAINT "loan_reschedule_installments" CHECK ("loan_reschedule"."installments" BETWEEN 1 AND 520),
	CONSTRAINT "loan_reschedule_first_due" CHECK ("loan_reschedule"."first_due_on" > "loan_reschedule"."business_date"),
	CONSTRAINT "loan_reschedule_reason" CHECK (length(trim("loan_reschedule"."reason")) BETWEEN 3 AND 300)
);
--> statement-breakpoint
CREATE TABLE "loan_reschedule_line" (
	"tenant_id" uuid NOT NULL,
	"reschedule_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"principal" bigint NOT NULL,
	"interest" bigint NOT NULL,
	CONSTRAINT "loan_reschedule_line_seq" UNIQUE("tenant_id","reschedule_id","seq"),
	CONSTRAINT "loan_reschedule_line_amounts" CHECK ("loan_reschedule_line"."principal" >= 0 AND "loan_reschedule_line"."interest" >= 0 AND "loan_reschedule_line"."principal" + "loan_reschedule_line"."interest" > 0)
);
--> statement-breakpoint
ALTER TABLE "loan_installment" ADD COLUMN "schedule_no" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_reschedule" ADD CONSTRAINT "loan_reschedule_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_reschedule" ADD CONSTRAINT "loan_reschedule_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loan"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_reschedule" ADD CONSTRAINT "loan_reschedule_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_reschedule_line" ADD CONSTRAINT "loan_reschedule_line_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_reschedule_line" ADD CONSTRAINT "loan_reschedule_line_reschedule_fk" FOREIGN KEY ("tenant_id","reschedule_id") REFERENCES "public"."loan_reschedule"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_reschedule_line" ADD CONSTRAINT "loan_reschedule_line_installment_fk" FOREIGN KEY ("tenant_id","loan_id","seq") REFERENCES "public"."loan_installment"("tenant_id","loan_id","seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_reschedule_line_installment" ON "loan_reschedule_line" USING btree ("tenant_id","loan_id","seq");--> statement-breakpoint
ALTER TABLE "loan_installment" ADD CONSTRAINT "loan_installment_schedule_no" CHECK ("loan_installment"."schedule_no" >= 0);