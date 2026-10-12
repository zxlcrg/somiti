-- Loan guarantors: named on the application only, never the borrower,
-- append-only, RLS and grants.
--
-- Runs as somiti_owner. Reuses SM002 (append-only) from 0001 and SM020
-- (already decided) from 0011; SM021 is a borrower named as their own guarantor.

CREATE FUNCTION loan_guarantor_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  l record;
BEGIN
  SELECT member_id, status INTO l FROM loan WHERE tenant_id = NEW.tenant_id AND id = NEW.loan_id;
  IF l.member_id = NEW.member_id THEN
    RAISE EXCEPTION 'a borrower cannot guarantee their own loan %', NEW.loan_id USING ERRCODE = 'SM021';
  END IF;
  IF l.status <> 'applied' THEN
    RAISE EXCEPTION 'loan % is already decided; its guarantors are fixed', NEW.loan_id USING ERRCODE = 'SM020';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loan_guarantor_guard BEFORE INSERT ON loan_guarantor
  FOR EACH ROW EXECUTE FUNCTION loan_guarantor_guard_insert();
--> statement-breakpoint
CREATE TRIGGER loan_guarantor_append_only BEFORE UPDATE OR DELETE ON loan_guarantor
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER loan_guarantor_no_truncate BEFORE TRUNCATE ON loan_guarantor
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
ALTER TABLE loan_guarantor ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE loan_guarantor FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON loan_guarantor
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON loan_guarantor TO somiti_app;
