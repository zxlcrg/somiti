-- Loan rescheduling: append-only records, RLS and grants.
--
-- Runs as somiti_owner.

CREATE TRIGGER loan_reschedule_append_only BEFORE UPDATE OR DELETE ON loan_reschedule
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER loan_reschedule_no_truncate BEFORE TRUNCATE ON loan_reschedule
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER loan_reschedule_line_append_only BEFORE UPDATE OR DELETE ON loan_reschedule_line
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER loan_reschedule_line_no_truncate BEFORE TRUNCATE ON loan_reschedule_line
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
ALTER TABLE loan_reschedule ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE loan_reschedule FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON loan_reschedule
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE loan_reschedule_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE loan_reschedule_line FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON loan_reschedule_line
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON loan_reschedule, loan_reschedule_line TO somiti_app;
