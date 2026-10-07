ALTER TYPE "public"."entry_source" ADD VALUE 'collector_handover' BEFORE 'reversal';--> statement-breakpoint
CREATE TABLE "collector_handover" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"collector_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"received_by" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_handover_entry" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "collector_handover_amount" CHECK ("collector_handover"."amount" > 0),
	CONSTRAINT "collector_handover_two_people" CHECK ("collector_handover"."received_by" <> "collector_handover"."collector_id")
);
--> statement-breakpoint
ALTER TABLE "collector_handover" ADD CONSTRAINT "collector_handover_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_handover" ADD CONSTRAINT "collector_handover_collector_fk" FOREIGN KEY ("tenant_id","collector_id") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_handover" ADD CONSTRAINT "collector_handover_received_by_fk" FOREIGN KEY ("tenant_id","received_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_handover" ADD CONSTRAINT "collector_handover_entry_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entry"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collector_handover_collector" ON "collector_handover" USING btree ("tenant_id","collector_id","created_at");