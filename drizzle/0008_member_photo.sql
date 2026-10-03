CREATE TABLE "member_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	CONSTRAINT "member_photo_type" CHECK ("member_photo"."content_type" IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "member_photo_size" CHECK ("member_photo"."byte_size" BETWEEN 1 AND 512000 AND "member_photo"."byte_size" = octet_length("member_photo"."bytes")),
	CONSTRAINT "member_photo_removed_together" CHECK (("member_photo"."removed_at" IS NULL) = ("member_photo"."removed_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "member_photo" ADD CONSTRAINT "member_photo_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_photo" ADD CONSTRAINT "member_photo_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."member"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_photo" ADD CONSTRAINT "member_photo_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_photo" ADD CONSTRAINT "member_photo_removed_by_fk" FOREIGN KEY ("tenant_id","removed_by") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_photo_one_current" ON "member_photo" USING btree ("tenant_id","member_id") WHERE "member_photo"."removed_at" IS NULL;