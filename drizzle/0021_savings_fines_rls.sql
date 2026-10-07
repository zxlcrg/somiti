-- Savings fines: append-only, RLS, narrow grants. Late fine is editable on a product.
--
-- Runs as somiti_owner. forbid_change() is 0001's append-only guard (SM002).

CREATE TRIGGER savings_fine_append_only BEFORE UPDATE OR DELETE ON savings_fine
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER savings_fine_no_truncate BEFORE TRUNCATE ON savings_fine
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
ALTER TABLE savings_fine ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE savings_fine FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON savings_fine
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON savings_fine TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (late_fine) ON savings_product TO somiti_app;
