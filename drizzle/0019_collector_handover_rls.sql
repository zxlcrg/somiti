-- Collector handovers: append-only, RLS, narrow grants.
--
-- Runs as somiti_owner. forbid_change() is 0001's append-only guard (SM002).

CREATE TRIGGER collector_handover_append_only BEFORE UPDATE OR DELETE ON collector_handover
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER collector_handover_no_truncate BEFORE TRUNCATE ON collector_handover
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
ALTER TABLE collector_handover ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE collector_handover FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON collector_handover
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON collector_handover TO somiti_app;
