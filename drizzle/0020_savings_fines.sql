CREATE TABLE "savings_fine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"installments" integer NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_fine_entry" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "savings_fine_amount" CHECK ("savings_fine"."amount" > 0),
	CONSTRAINT "savings_fine_installments" CHECK ("savings_fine"."installments" > 0)
);
--> statement-breakpoint
ALTER TABLE "savings_product" ADD COLUMN "late_fine" bigint;--> statement-breakpoint
ALTER TABLE "savings_fine" ADD CONSTRAINT "savings_fine_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_fine" ADD CONSTRAINT "savings_fine_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."savings_account"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_fine" ADD CONSTRAINT "savings_fine_entry_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_fine" ADD CONSTRAINT "savings_fine_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "savings_fine_date" ON "savings_fine" USING btree ("tenant_id","business_date");--> statement-breakpoint
ALTER TABLE "savings_product" ADD CONSTRAINT "savings_product_late_fine" CHECK ("savings_product"."late_fine" IS NULL OR ("savings_product"."late_fine" > 0 AND "savings_product"."frequency" <> 'flexible'));