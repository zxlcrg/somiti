CREATE TYPE "public"."sms_kind" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."sms_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "sms_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"to_phone" text NOT NULL,
	"body" text NOT NULL,
	"kind" "sms_kind" NOT NULL,
	"ref_id" uuid NOT NULL,
	"status" "sms_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "sms_outbox_ref" UNIQUE("tenant_id","kind","ref_id"),
	CONSTRAINT "sms_outbox_sent_at" CHECK (("sms_outbox"."status" = 'sent') = ("sms_outbox"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_outbox_queued" ON "sms_outbox" USING btree ("tenant_id","status","created_at");