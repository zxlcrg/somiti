CREATE TYPE "public"."guardian_relation" AS ENUM('father', 'husband');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'exited', 'deceased');--> statement-breakpoint
CREATE TABLE "member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"member_no" integer NOT NULL,
	"name_en" text,
	"name_bn" text,
	"guardian_relation" "guardian_relation",
	"guardian_name_en" text,
	"guardian_name_bn" text,
	"phone" text NOT NULL,
	"nid_cipher" text,
	"nid_hash" text,
	"nid_last4" text,
	"date_of_birth" date,
	"address" text,
	"comm_locale" "locale",
	"admission_date" date NOT NULL,
	"status" "member_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "member_tenant_member_no" UNIQUE("tenant_id","member_no"),
	CONSTRAINT "member_tenant_nid_hash" UNIQUE("tenant_id","nid_hash"),
	CONSTRAINT "member_has_name" CHECK ("member"."name_en" IS NOT NULL OR "member"."name_bn" IS NOT NULL),
	CONSTRAINT "member_no_positive" CHECK ("member"."member_no" > 0),
	CONSTRAINT "member_nid_complete" CHECK (("member"."nid_cipher" IS NULL) = ("member"."nid_hash" IS NULL) AND ("member"."nid_cipher" IS NULL) = ("member"."nid_last4" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_tenant_phone" ON "member" USING btree ("tenant_id","phone");--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;