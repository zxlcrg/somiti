-- Row-level security and grants for sign-in, plus finding a somiti by its code.
--
-- Runs as somiti_owner, like 0001.

------------------------------------------------------------------------------
-- Finding a somiti by the code a person types on the sign-in page
------------------------------------------------------------------------------

-- Before sign-in there is no current tenant, so tenant_isolation hides every
-- row. The app sets app.tenant_slug for one transaction (resolveTenantSlug in
-- src/db/client.ts) and may read back only the row with exactly that slug.
-- Knowing a slug is the only way to see its row; nothing can be listed.
CREATE FUNCTION app_requested_slug() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_slug', true), '') $$;
--> statement-breakpoint
CREATE POLICY tenant_by_slug ON tenant FOR SELECT
  USING (slug = app_requested_slug());
--> statement-breakpoint

------------------------------------------------------------------------------
-- Row-level security on the new tables, forced for the owner too
------------------------------------------------------------------------------

ALTER TABLE otp_challenge ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE otp_challenge FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON otp_challenge
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE user_session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_session FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_session
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

------------------------------------------------------------------------------
-- Grants. Codes and sessions are never deleted, only spent or revoked, so
-- the history stays for audit.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON otp_challenge, user_session TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (attempts, consumed_at) ON otp_challenge TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (last_seen_at, revoked_at) ON user_session TO somiti_app;
