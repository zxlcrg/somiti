CREATE TABLE "loan_fine" (
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"repayment_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"waived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "loan_fine_installment" UNIQUE("tenant_id","loan_id","seq"),
	CONSTRAINT "loan_fine_amount" CHECK (("loan_fine"."waived" AND "loan_fine"."amount" = 0) OR (NOT "loan_fine"."waived" AND "loan_fine"."amount" > 0))
);
--> statement-breakpoint
ALTER TABLE "loan_repayment" DROP CONSTRAINT "loan_repayment_amounts";--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "late_fine" bigint;--> statement-breakpoint
ALTER TABLE "loan_product" ADD COLUMN "late_fine" bigint;--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD COLUMN "fine" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_fine" ADD CONSTRAINT "loan_fine_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_fine" ADD CONSTRAINT "loan_fine_installment_fk" FOREIGN KEY ("tenant_id","loan_id","seq") REFERENCES "public"."loan_installment"("tenant_id","loan_id","seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_fine" ADD CONSTRAINT "loan_fine_repayment_fk" FOREIGN KEY ("tenant_id","repayment_id") REFERENCES "public"."loan_repayment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_product" ADD CONSTRAINT "loan_product_late_fine" CHECK ("loan_product"."late_fine" IS NULL OR "loan_product"."late_fine" > 0);--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD CONSTRAINT "loan_repayment_amounts" CHECK ("loan_repayment"."amount" > 0 AND "loan_repayment"."principal" >= 0 AND "loan_repayment"."interest" >= 0 AND "loan_repayment"."fine" >= 0 AND "loan_repayment"."amount" = "loan_repayment"."principal" + "loan_repayment"."interest");