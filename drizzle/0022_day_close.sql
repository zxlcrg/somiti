ALTER TYPE "public"."entry_source" ADD VALUE 'day_close' BEFORE 'reversal';--> statement-breakpoint
CREATE TABLE "day_close" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"expected" bigint NOT NULL,
	"counted" bigint NOT NULL,
	"breakdown" jsonb NOT NULL,
	"entry_id" uuid,
	"note" text,
	"closed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_close_date" UNIQUE("tenant_id","business_date"),
	CONSTRAINT "day_close_counted" CHECK ("day_close"."counted" >= 0),
	CONSTRAINT "day_close_difference_posted" CHECK (("day_close"."counted" = "day_close"."expected") = ("day_close"."entry_id" IS NULL)),
	CONSTRAINT "day_close_difference_explained" CHECK ("day_close"."counted" = "day_close"."expected" OR "day_close"."note" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "day_close" ADD CONSTRAINT "day_close_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_close" ADD CONSTRAINT "day_close_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_close" ADD CONSTRAINT "day_close_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;