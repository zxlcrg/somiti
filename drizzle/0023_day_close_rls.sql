-- Day close: append-only, RLS, narrow grants.
--
-- Runs as somiti_owner. forbid_change() is 0001's append-only guard (SM002).

CREATE TRIGGER day_close_append_only BEFORE UPDATE OR DELETE ON day_close
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER day_close_no_truncate BEFORE TRUNCATE ON day_close
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
ALTER TABLE day_close ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE day_close FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON day_close
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON day_close TO somiti_app;
