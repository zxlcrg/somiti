CREATE TABLE "otp_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenge_attempts" CHECK ("otp_challenge"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "otp_challenge_user_created" ON "otp_challenge" USING btree ("tenant_id","user_id","created_at");