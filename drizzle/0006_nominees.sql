CREATE TYPE "public"."nominee_relation" AS ENUM('spouse', 'son', 'daughter', 'father', 'mother', 'brother', 'sister', 'other');--> statement-breakpoint
CREATE TABLE "nominee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name_en" text,
	"name_bn" text,
	"relation" "nominee_relation" NOT NULL,
	"phone" text,
	"nid_cipher" text,
	"nid_hash" text,
	"nid_last4" text,
	"date_of_birth" date,
	"minor_guardian_name_en" text,
	"minor_guardian_name_bn" text,
	"share_bp" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	CONSTRAINT "nominee_has_name" CHECK ("nominee"."name_en" IS NOT NULL OR "nominee"."name_bn" IS NOT NULL),
	CONSTRAINT "nominee_share_range" CHECK ("nominee"."share_bp" BETWEEN 1 AND 10000),
	CONSTRAINT "nominee_removed_together" CHECK (("nominee"."removed_at" IS NULL) = ("nominee"."removed_by" IS NULL)),
	CONSTRAINT "nominee_nid_complete" CHECK (("nominee"."nid_cipher" IS NULL) = ("nominee"."nid_hash" IS NULL) AND ("nominee"."nid_cipher" IS NULL) = ("nominee"."nid_last4" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "nominee" ADD CONSTRAINT "nominee_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nominee" ADD CONSTRAINT "nominee_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nominee" ADD CONSTRAINT "nominee_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nominee" ADD CONSTRAINT "nominee_removed_by_fk" FOREIGN KEY ("tenant_id","removed_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nominee_tenant_member" ON "nominee" USING btree ("tenant_id","member_id");