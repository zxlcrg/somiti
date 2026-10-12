-- Writing off a loan: the loan may go from disbursed to written_off; the
-- request is decided once, by someone other than who asked; at most one
-- request waits per loan. RLS and narrow grants.
--
-- Runs as somiti_owner. Replaces the 0037 loan guard. Reuses SM002
-- (append-only) and SM020 (already decided).

CREATE OR REPLACE FUNCTION loan_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT (
       (OLD.status = 'applied' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('disbursed', 'cancelled'))
    OR (OLD.status = 'disbursed' AND NEW.status IN ('closed', 'written_off'))
  ) THEN
    RAISE EXCEPTION 'loan % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'SM020';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.loan_no <> OLD.loan_no
     OR NEW.member_id <> OLD.member_id OR NEW.product_id <> OLD.product_id
     OR NEW.principal <> OLD.principal OR NEW.method <> OLD.method OR NEW.rate_bp <> OLD.rate_bp
     OR NEW.frequency <> OLD.frequency OR NEW.installments <> OLD.installments
     OR NEW.processing_fee <> OLD.processing_fee OR NEW.allocation <> OLD.allocation OR NEW.late_fine IS DISTINCT FROM OLD.late_fine
     OR NEW.settlement_rebate_bp <> OLD.settlement_rebate_bp OR NEW.purpose IS DISTINCT FROM OLD.purpose
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
CREATE FUNCTION loan_write_off_guard_decision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'write-off % is already %', OLD.id, OLD.status USING ERRCODE = 'SM020';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.loan_id <> OLD.loan_id
     OR NEW.reason <> OLD.reason OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_on <> OLD.requested_on OR NEW.created_at <> OLD.created_at
     OR NEW.submit_key <> OLD.submit_key THEN
    RAISE EXCEPTION 'only the decision on write-off % can change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER loan_write_off_guard_decision BEFORE UPDATE ON loan_write_off
  FOR EACH ROW EXECUTE FUNCTION loan_write_off_guard_decision();
--> statement-breakpoint
CREATE TRIGGER loan_write_off_no_delete BEFORE DELETE ON loan_write_off
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER loan_write_off_no_truncate BEFORE TRUNCATE ON loan_write_off
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE UNIQUE INDEX loan_write_off_one_pending ON loan_write_off (tenant_id, loan_id) WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE loan_write_off ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE loan_write_off FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON loan_write_off
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON loan_write_off TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, principal, charge, entry_id) ON loan_write_off TO somiti_app;
