CREATE TABLE "loan_guarantor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_guarantor_member" UNIQUE("tenant_id","loan_id","member_id"),
	CONSTRAINT "loan_guarantor_position" UNIQUE("tenant_id","loan_id","position"),
	CONSTRAINT "loan_guarantor_position_range" CHECK ("loan_guarantor"."position" BETWEEN 1 AND 3)
);
--> statement-breakpoint
ALTER TABLE "loan_product" ADD COLUMN "guarantors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_guarantor" ADD CONSTRAINT "loan_guarantor_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_guarantor" ADD CONSTRAINT "loan_guarantor_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loan"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_guarantor" ADD CONSTRAINT "loan_guarantor_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_guarantor" ADD CONSTRAINT "loan_guarantor_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_guarantor_member_idx" ON "loan_guarantor" USING btree ("tenant_id","member_id");--> statement-breakpoint
ALTER TABLE "loan_product" ADD CONSTRAINT "loan_product_guarantors" CHECK ("loan_product"."guarantors" BETWEEN 0 AND 3);