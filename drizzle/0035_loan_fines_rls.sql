-- Loan late fines: frozen fine rule, append-only fines, RLS and grants.
--
-- Runs as somiti_owner. Replaces the 0033 guard so a loan's late fine is
-- frozen with its other terms.

CREATE OR REPLACE FUNCTION loan_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT (
       (OLD.status = 'applied' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('disbursed', 'cancelled'))
    OR (OLD.status = 'disbursed' AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'loan % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'SM020';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.loan_no <> OLD.loan_no
     OR NEW.member_id <> OLD.member_id OR NEW.product_id <> OLD.product_id
     OR NEW.principal <> OLD.principal OR NEW.method <> OLD.method OR NEW.rate_bp <> OLD.rate_bp
     OR NEW.frequency <> OLD.frequency OR NEW.installments <> OLD.installments
     OR NEW.processing_fee <> OLD.processing_fee OR NEW.allocation <> OLD.allocation OR NEW.late_fine IS DISTINCT FROM OLD.late_fine OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.applied_by <> OLD.applied_by OR NEW.applied_on <> OLD.applied_on
     OR NEW.created_at <> OLD.created_at OR NEW.submit_key IS DISTINCT FROM OLD.submit_key THEN
    RAISE EXCEPTION 'the terms of loan % cannot change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  -- A decision, once made, stays as made; so does a disbursement.
  IF OLD.decided_by IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.meeting_on IS DISTINCT FROM OLD.meeting_on
     OR (NEW.status <> 'cancelled' AND NEW.decision_note IS DISTINCT FROM OLD.decision_note)) THEN
    RAISE EXCEPTION 'the decision on loan % cannot change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  IF OLD.entry_id IS NOT NULL AND (NEW.entry_id IS DISTINCT FROM OLD.entry_id
     OR NEW.disbursed_by IS DISTINCT FROM OLD.disbursed_by OR NEW.disbursed_on IS DISTINCT FROM OLD.disbursed_on
     OR NEW.payment_method IS DISTINCT FROM OLD.payment_method OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref) THEN
    RAISE EXCEPTION 'the disbursement of loan % cannot change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  -- Closing is the last word on a loan.
  IF OLD.closed_on IS NOT NULL AND NEW.closed_on IS DISTINCT FROM OLD.closed_on THEN
    RAISE EXCEPTION 'the closing of loan % cannot change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER loan_fine_append_only BEFORE UPDATE OR DELETE ON loan_fine
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER loan_fine_no_truncate BEFORE TRUNCATE ON loan_fine
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
ALTER TABLE loan_fine ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE loan_fine FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON loan_fine
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON loan_fine TO somiti_app;
