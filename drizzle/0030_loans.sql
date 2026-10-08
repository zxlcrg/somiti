CREATE TYPE "public"."loan_charge_label" AS ENUM('interest', 'service_charge');--> statement-breakpoint
CREATE TYPE "public"."loan_frequency" AS ENUM('weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."loan_method" AS ENUM('flat', 'declining');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('applied', 'approved', 'rejected', 'cancelled', 'disbursed', 'closed');--> statement-breakpoint
ALTER TYPE "public"."entry_source" ADD VALUE 'loan_disbursement' BEFORE 'reversal';--> statement-breakpoint
CREATE TABLE "loan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_no" integer NOT NULL,
	"member_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"principal" bigint NOT NULL,
	"method" "loan_method" NOT NULL,
	"rate_bp" integer NOT NULL,
	"frequency" "loan_frequency" NOT NULL,
	"installments" integer NOT NULL,
	"processing_fee" bigint NOT NULL,
	"purpose" text,
	"status" "loan_status" DEFAULT 'applied' NOT NULL,
	"applied_by" uuid NOT NULL,
	"applied_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submit_key" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"meeting_on" date,
	"disbursed_by" uuid,
	"disbursed_on" date,
	"payment_method" "payment_method",
	"payment_ref" text,
	"entry_id" uuid,
	CONSTRAINT "loan_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_no" UNIQUE("tenant_id","loan_no"),
	CONSTRAINT "loan_submit_key" UNIQUE("tenant_id","submit_key"),
	CONSTRAINT "loan_entry" UNIQUE("tenant_id","entry_id"),
	CONSTRAINT "loan_no_positive" CHECK ("loan"."loan_no" > 0),
	CONSTRAINT "loan_principal" CHECK ("loan"."principal" > 0),
	CONSTRAINT "loan_rate" CHECK ("loan"."rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "loan_installments" CHECK ("loan"."installments" BETWEEN 1 AND 520),
	CONSTRAINT "loan_fee" CHECK ("loan"."processing_fee" >= 0 AND "loan"."processing_fee" < "loan"."principal"),
	CONSTRAINT "loan_checker_not_maker" CHECK ("loan"."status" NOT IN ('approved', 'rejected', 'disbursed', 'closed') OR "loan"."decided_by" <> "loan"."applied_by"),
	CONSTRAINT "loan_decided" CHECK (("loan"."status" = 'applied') = ("loan"."decided_by" IS NULL) AND ("loan"."decided_by" IS NULL) = ("loan"."decided_at" IS NULL)),
	CONSTRAINT "loan_reject_note" CHECK ("loan"."status" <> 'rejected' OR length(trim(coalesce("loan"."decision_note", ''))) > 0),
	CONSTRAINT "loan_disbursed" CHECK (("loan"."status" IN ('disbursed', 'closed')) = ("loan"."entry_id" IS NOT NULL)
          AND ("loan"."entry_id" IS NULL) = ("loan"."disbursed_on" IS NULL)
          AND ("loan"."entry_id" IS NULL) = ("loan"."disbursed_by" IS NULL)
          AND ("loan"."entry_id" IS NULL) = ("loan"."payment_method" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "loan_installment" (
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"due_on" date NOT NULL,
	"principal" bigint NOT NULL,
	"interest" bigint NOT NULL,
	CONSTRAINT "loan_installment_seq" UNIQUE("tenant_id","loan_id","seq"),
	CONSTRAINT "loan_installment_seq_positive" CHECK ("loan_installment"."seq" > 0),
	CONSTRAINT "loan_installment_amounts" CHECK ("loan_installment"."principal" >= 0 AND "loan_installment"."interest" >= 0 AND "loan_installment"."principal" + "loan_installment"."interest" > 0)
);
--> statement-breakpoint
CREATE TABLE "loan_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_bn" text,
	"method" "loan_method" NOT NULL,
	"charge_label" "loan_charge_label" DEFAULT 'service_charge' NOT NULL,
	"rate_bp" integer NOT NULL,
	"frequency" "loan_frequency" NOT NULL,
	"min_amount" bigint NOT NULL,
	"max_amount" bigint NOT NULL,
	"max_installments" integer NOT NULL,
	"processing_fee_bp" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_product_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_product_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "loan_product_code_format" CHECK ("loan_product"."code" ~ '^[A-Z0-9-]{1,12}$'),
	CONSTRAINT "loan_product_name" CHECK (length(trim("loan_product"."name_en")) BETWEEN 1 AND 80),
	CONSTRAINT "loan_product_rate" CHECK ("loan_product"."rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "loan_product_amounts" CHECK ("loan_product"."min_amount" > 0 AND "loan_product"."max_amount" >= "loan_product"."min_amount"),
	CONSTRAINT "loan_product_installments" CHECK ("loan_product"."max_installments" BETWEEN 1 AND 520),
	CONSTRAINT "loan_product_fee" CHECK ("loan_product"."processing_fee_bp" BETWEEN 0 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."loan_product"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_applied_by_fk" FOREIGN KEY ("tenant_id","applied_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_disbursed_by_fk" FOREIGN KEY ("tenant_id","disbursed_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_installment" ADD CONSTRAINT "loan_installment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_installment" ADD CONSTRAINT "loan_installment_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loan"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_product" ADD CONSTRAINT "loan_product_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_product" ADD CONSTRAINT "loan_product_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_member" ON "loan" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE INDEX "loan_status" ON "loan" USING btree ("tenant_id","status","created_at");